import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { collectWrittenPaths, dispatchHook } from "../src/hook.js"
import { checkIn } from "../src/protocol.js"
import { SessionStore } from "../src/state.js"

const roots: string[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "parallax-hook-test-"))
  roots.push(root)
  return root
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("deterministic hook dispatcher", () => {
  it("registers every native lifecycle hook in exec form", () => {
    type Handler = { type: string; command: string; args?: string[] }
    const config = JSON.parse(readFileSync(join(process.cwd(), "hooks", "hooks.json"), "utf8")) as { hooks: Record<string, Array<{ matcher?: string; hooks: Handler[] }>> }
    expect(Object.keys(config.hooks)).toEqual([
      "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolBatch", "PostToolUseFailure",
      "SubagentStart", "PreCompact", "Stop", "SessionEnd",
    ])
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          expect(handler).toMatchObject({ type: "command", command: "node" })
          expect(handler.args).toHaveLength(2)
          expect(handler.args![0]).toBe("${CLAUDE_PLUGIN_ROOT}/dist/hook.js")
        }
      }
    }
    expect(config.hooks.PostToolBatch![0]!.matcher).toBeUndefined()
    expect(config.hooks.PostToolBatch![0]!.hooks[0]!.args![1]).toBe("PostToolBatch")
  })

  it("fails closed until the ordered write prerequisites are persisted", async () => {
    const cwd = temporary()
    const session_id = "hook-session"
    await dispatchHook("SessionStart", { session_id, cwd })

    const blocked = await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_input: { file_path: "a.ts" } })
    expect(blocked).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } })

    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      expect(state).not.toBeNull()
      checkIn(state!, "ambiguity", "No unresolved ambiguity")
      checkIn(state!, "invariants", "Ownership and timing reviewed")
      checkIn(state!, "gate", "Tests define the write gate")
      return state!
    })
    const allowed = await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_input: { file_path: "a.ts" } })
    expect(allowed).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse" } })
    expect((allowed.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined()
  })

  it("verifies once and records every unique path in a mutation batch", async () => {
    const cwd = temporary()
    const session_id = "batch-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    await dispatchHook("PostToolBatch", {
      session_id,
      cwd,
      tool_calls: [
        { tool_name: "Read", tool_input: { file_path: "not-written.ts" } },
        { tool_name: "Edit", tool_input: { file_path: "a.ts", edits: [{ filePath: "b.ts" }, { file_path: "a.ts" }] } },
        { tool_name: "NotebookEdit", tool_input: { notebook_path: "notes.ipynb" } },
      ],
    })

    const state = new SessionStore(cwd).read(session_id)!
    expect(state.trace.verifications).toHaveLength(1)
    expect(state.trace.writes.map((write) => write.file)).toEqual(["a.ts", "b.ts", "notes.ipynb"])
    expect(new Set(state.trace.writes.map((write) => write.batchId)).size).toBe(1)
    expect(new Set(state.trace.writes.map((write) => write.verificationId)).size).toBe(1)
  })

  it("does not verify or trace a mutation denied by the write gate", async () => {
    const cwd = temporary()
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(1)\"" } }))
    const session_id = "denied-batch-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    expect(await dispatchHook("PostToolBatch", {
      session_id,
      cwd,
      tool_calls: [{
        tool_name: "Write",
        tool_input: { file_path: "blocked.ts" },
        tool_response: `[parallax] Write blocked. Complete ambiguity -> invariants -> gate with parallax_checkin for session ${session_id} and concrete evidence before Write.`,
      }],
    })).toEqual({})
    const state = new SessionStore(cwd).read(session_id)!
    expect(state.friction).toMatchObject({ trials: 0, retriesLeft: 3 })
    expect(state.trace.writes).toEqual([])
    expect(state.trace.verifications).toEqual([])
  })

  it("rejects failed or denied top-level fallback mutations without inventing success", async () => {
    const cwd = temporary()
    const session_id = "fallback-failure-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    for (const payload of [
      { status: "failed", tool_response: { status: "failed", message: "write failed" } },
      { status: "denied", tool_response: { denied: true } },
      { tool_response: { error: "permission denied" } },
      { tool_response: { isError: true, message: "rejected" } },
      { tool_response: { message: "permission denied" } },
      { tool_response: { stderr: "edit failed" } },
      { tool_response: "Edit failed: replacement rejected" },
    ]) {
      expect(await dispatchHook("PostToolBatch", { session_id, cwd, tool_name: "Write", tool_input: { file_path: "never.ts" }, ...payload })).toEqual({})
    }
    expect(new SessionStore(cwd).read(session_id)!.trace.writes).toEqual([])
  })

  it("opens a fresh bounded manual recovery epoch on a new user prompt", async () => {
    const cwd = temporary()
    const session_id = "manual-recovery-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      state!.friction.consecutiveFailures = state!.friction.maxRetries
      state!.friction.retriesLeft = 0
      state!.friction.recoveryAttempts = 3
      state!.friction.lastObservation = "still failing"
      return state!
    })
    await dispatchHook("UserPromptSubmit", { session_id, cwd })
    expect(store.read(session_id)!.friction).toMatchObject({ retriesLeft: 0, recoveryAttempts: 0, lastObservation: "still failing" })
  })

  it("ignores a read-only native tool batch", async () => {
    const cwd = temporary()
    const session_id = "read-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    expect(await dispatchHook("PostToolBatch", {
      session_id,
      cwd,
      tool_calls: [{ tool_name: "Read", tool_input: { file_path: "a.ts" } }],
    })).toEqual({})
    const state = new SessionStore(cwd).read(session_id)!
    expect(state.trace.writes).toEqual([])
    expect(state.trace.verifications).toEqual([])
  })

  it("injects concise recovery output after batch verification fails", async () => {
    const cwd = temporary()
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { check: "node -e \"console.error('batch-check-failed');process.exit(1)\"" } }))
    const session_id = "verify-failure-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const output = await dispatchHook("PostToolBatch", {
      session_id,
      cwd,
      tool_calls: [{ tool_name: "Write", tool_input: { file_path: "broken.ts" } }],
    })
    expect(JSON.stringify(output)).toContain("Recover:")
    expect(JSON.stringify(output)).toContain("batch-check-failed")
    const state = new SessionStore(cwd).read(session_id)!
    expect(state.friction.retriesLeft).toBe(2)
    expect(state.trace.verifications).toHaveLength(1)
  })

  it("checkpoints at Stop and only finalizes at SessionEnd", async () => {
    const cwd = temporary()
    const session_id = "final-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const failure = await dispatchHook("PostToolUseFailure", {
      session_id,
      cwd,
      tool_name: "Edit",
      tool_input: { file_path: "broken.ts" },
      error: "replacement did not match",
    })
    expect(JSON.stringify(failure)).toContain("Recover: replacement did not match")

    const stopped = await dispatchHook("Stop", { session_id, cwd })
    expect(JSON.stringify(stopped)).toContain("session remains active")
    let state = new SessionStore(cwd).read(session_id)!
    expect(state.trace.session.endedAt).toBeNull()
    expect(state.trace.metrics).not.toBeNull()
    expect(state.trace.coherenceScore).not.toBeNull()
    await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [{ tool_name: "Write", tool_input: { file_path: "after-checkpoint.ts" } }] })
    state = new SessionStore(cwd).read(session_id)!
    expect(state.trace.metrics).toBeNull()
    expect(state.trace.coherenceScore).toBeNull()
    await dispatchHook("SessionEnd", { session_id, cwd })
    state = new SessionStore(cwd).read(session_id)!
    expect(state.trace.session.endedAt).not.toBeNull()
    expect(JSON.parse(readFileSync(join(cwd, ".parallax", "traces", `${session_id}.json`), "utf8")).session.id).toBe(session_id)
  })

  it("gates Bash, starts a fresh task epoch after mutation, and correlates structured batch results", async () => {
    const cwd = temporary()
    const session_id = "epoch-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    expect(await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Bash", tool_input: { command: "echo x > a" } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      checkIn(state!, "ambiguity", "No unresolved ambiguity")
      checkIn(state!, "invariants", "Ownership and timing reviewed")
      checkIn(state!, "gate", "Tests define the write gate")
      return state!
    })
    await dispatchHook("PostToolBatch", {
      session_id, cwd,
      tool_calls: [
        { tool_use_id: "ok", tool_name: "Write", tool_input: { file_path: "ok.ts" } },
        { tool_use_id: "denied", tool_name: "Edit", tool_input: { file_path: "denied.ts" } },
        { tool_use_id: "failed", tool_name: "Bash", tool_input: { command: "exit 1" } },
      ],
      tool_results: [
        { tool_use_id: "ok", status: "success" },
        { tool_use_id: "denied", status: "denied" },
        { tool_use_id: "failed", status: "failed" },
      ],
    })
    expect(store.read(session_id)!.trace.writes.map((write) => write.file)).toEqual(["ok.ts"])
    await dispatchHook("UserPromptSubmit", { session_id, cwd })
    const next = store.read(session_id)!
    expect(next.protocol.epoch).toBe(2)
    expect(next.protocol.completed.ambiguity).toBe(false)
  })

  it("collects path aliases recursively without duplicate write records", () => {
    expect(collectWrittenPaths({ files: [{ file_path: "a" }, { filePath: "b" }], notebookPath: "c", duplicate: { file_path: "a" } })).toEqual(["c", "a", "b"])
  })
})
