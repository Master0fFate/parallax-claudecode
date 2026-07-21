import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { collectWrittenPaths, dispatchHook } from "../src/hook.js"
import { MutationIntentQueue } from "../src/mutation-queue.js"
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
      "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolBatch", "PostToolUseFailure",
      "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "Stop", "SessionEnd",
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
    expect(config.hooks.SubagentStart![0]!.matcher).toBe("^parallax-claudecode:horizon-(worker|auditor)$")
    expect(config.hooks.SubagentStop![0]!.matcher).toBe("^parallax-claudecode:horizon-(worker|auditor)$")
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
    const allowed = await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "allow-write", tool_input: { file_path: "a.ts" } })
    expect(allowed).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse" } })
    expect((allowed.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined()
  })

  it("persists a validated intent before yielding to Claude permissions and denies malformed payloads", async () => {
    const cwd = temporary()
    const session_id = "intent-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    expect(await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_input: { file_path: "missing-id.ts" } }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    const allowed = await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "toolu-write", tool_input: { file_path: ".\\src\\file.ts" } })
    expect((allowed.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined()
    expect(new MutationIntentQueue(cwd, session_id).read().pending).toMatchObject([
      { toolUseId: "toolu-write", tool: "Write", targets: ["src/file.ts"] },
    ])
  })

  it("attributes Bash visibly as unknown and filters denied official batch calls", async () => {
    const cwd = temporary()
    const session_id = "official-batch-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Bash", tool_use_id: "bash-ok", tool_input: { command: "npm test" } })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "write-denied", tool_input: { file_path: "invented.ts" } })
    await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [
      { tool_name: "Bash", tool_use_id: "bash-ok", tool_input: { command: "npm test" }, tool_response: "Command completed" },
      { tool_name: "Write", tool_use_id: "write-denied", tool_input: { file_path: "invented.ts" }, tool_response: "Permission denied" },
    ] })
    const state = store.read(session_id)!
    expect(state.trace.writes.map((write) => write.file)).toEqual(["<unknown:Bash>"])
    expect(state.trace.verifications[0]!.changedFiles).toEqual([])
    expect(new MutationIntentQueue(cwd, session_id).read().pending).toEqual([])
  })

  it("hydrates resume and checkpoints on both compaction boundaries without losing evidence", async () => {
    const cwd = temporary()
    const session_id = "compact-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      checkIn(state!, "ambiguity", "durable evidence")
      return state!
    })
    await dispatchHook("SessionStart", { session_id, cwd, source: "resume" })
    expect(store.read(session_id)!.protocol.evidence.ambiguity).toBe("durable evidence")
    await dispatchHook("PreCompact", { session_id, cwd })
    const before = store.read(session_id)!.trace.phases.length
    await dispatchHook("PostCompact", { session_id, cwd })
    expect(store.read(session_id)!.trace.phases.length).toBe(before)
    expect(store.read(session_id)!.trace.metrics).not.toBeNull()
  })

  it("verifies once and records every unique path in a mutation batch", async () => {
    const cwd = temporary()
    const session_id = "batch-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      checkIn(state!, "ambiguity", "No unresolved ambiguity")
      checkIn(state!, "invariants", "Ownership and timing reviewed")
      checkIn(state!, "gate", "Tests define the write gate")
      return state!
    })
    for (const [tool_name, tool_use_id, tool_input] of [
      ["Edit", "edit", { file_path: "a.ts" }],
      ["NotebookEdit", "notebook", { notebook_path: "notes.ipynb" }],
    ] as const) await dispatchHook("PreToolUse", { session_id, cwd, tool_name, tool_use_id, tool_input })
    await dispatchHook("PostToolBatch", {
      session_id,
      cwd,
      tool_calls: [
        { tool_use_id: "read", tool_name: "Read", tool_input: { file_path: "not-written.ts" }, tool_response: "File read" },
        { tool_use_id: "edit", tool_name: "Edit", tool_input: { file_path: "a.ts" }, tool_response: "File updated" },
        { tool_use_id: "notebook", tool_name: "NotebookEdit", tool_input: { notebook_path: "notes.ipynb" }, tool_response: "Notebook updated" },
      ],
    })

    const state = store.read(session_id)!
    expect(state.trace.verifications).toHaveLength(1)
    const ledger = readFileSync(join(cwd, ".parallax", "verification-ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ id: state.trace.verifications[0]!.id, source: "automatic" })
    expect(state.trace.writes.map((write) => write.file)).toEqual(["a.ts", "notes.ipynb"])
    expect(new Set(state.trace.writes.map((write) => write.batchId)).size).toBe(1)
    expect(new Set(state.trace.writes.map((write) => write.verificationId)).size).toBe(1)
  })

  it("requires ID, exact tool, and normalized full-input correlation before verification", async () => {
    const cwd = temporary()
    const session_id = "correlation-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    const originalInput = { file_path: ".\\src\\same.ts", content: "original" }
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "bound", tool_input: originalInput })

    for (const call of [
      { tool_use_id: "other", tool_name: "Write", tool_input: originalInput, tool_response: "File written" },
      { tool_use_id: "bound", tool_name: "Edit", tool_input: { file_path: "src/same.ts", old_string: "x", new_string: "y" }, tool_response: "File updated" },
      { tool_use_id: "bound", tool_name: "Write", tool_input: { file_path: "src/same.ts", content: "different" }, tool_response: "File written" },
    ]) {
      await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [call] })
      expect(store.read(session_id)!.trace.verifications).toEqual([])
      expect(new MutationIntentQueue(cwd, session_id).read().pending.map((intent) => intent.toolUseId)).toEqual(["bound"])
    }
    expect(await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "later", tool_input: { file_path: "later.ts", content: "x" } }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })

    await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [
      { tool_use_id: "bound", tool_name: "Write", tool_input: { file_path: "src/same.ts", content: "original" }, tool_response: "File written" },
    ] })
    expect(store.read(session_id)!.trace.writes.map((write) => write.file)).toEqual(["src/same.ts"])
    expect(new MutationIntentQueue(cwd, session_id).read()).toMatchObject({ pending: [], active: null, unresolved: null })
  })

  it("accepts documented response forms and retains ambiguous or arbitrary responses", async () => {
    const cwd = temporary()
    const session_id = "response-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "blocks", tool_input: { file_path: "blocks.ts", content: "x" } })
    await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [
      { tool_use_id: "blocks", tool_name: "Write", tool_input: { content: "x", file_path: "blocks.ts" }, tool_response: [{ type: "text", text: "File written" }] },
    ] })
    expect(store.read(session_id)!.trace.verifications).toHaveLength(1)

    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Edit", tool_use_id: "unknown", tool_input: { file_path: "blocks.ts", old_string: "x", new_string: "y" } })
    for (const tool_response of [{ message: "completed" }, [{ arbitrary: true }], [{ type: "text" }]]) {
      await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [
        { tool_use_id: "unknown", tool_name: "Edit", tool_input: { file_path: "blocks.ts", old_string: "x", new_string: "y" }, tool_response },
      ] })
      expect(store.read(session_id)!.trace.verifications).toHaveLength(1)
    }
    await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [
      { tool_use_id: "unknown", tool_name: "Edit", tool_input: { file_path: "blocks.ts", old_string: "x", new_string: "y" }, tool_response: "Edit failed: cancelled" },
    ] })
    expect(new MutationIntentQueue(cwd, session_id).read()).toMatchObject({ pending: [], unresolved: null })
    expect(store.read(session_id)!.trace.verifications).toHaveLength(1)
  })

  it("retains malformed batches and surfaces unresolved intents across resume and compaction", async () => {
    const cwd = temporary()
    const session_id = "lifecycle-intent-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "unevidenced", tool_input: { file_path: "pending.ts", content: "x" } })
    const malformed = await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [{ tool_name: "Write" }] })
    expect(JSON.stringify(malformed)).toContain("retained")
    expect(JSON.stringify(await dispatchHook("SessionStart", { session_id, cwd, source: "resume" }))).toContain("Reconciliation required")
    expect(JSON.stringify(await dispatchHook("PreCompact", { session_id, cwd }))).toContain("Reconciliation required")
    expect(JSON.stringify(await dispatchHook("PostCompact", { session_id, cwd }))).toContain("Reconciliation required")
    expect(store.read(session_id)!.trace.verifications).toEqual([])
    expect(new MutationIntentQueue(cwd, session_id).read().pending).toHaveLength(1)
  })

  it("blocks on an empty official batch and recovers once from exact later evidence", async () => {
    const cwd = temporary()
    const session_id = "empty-official-batch-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    const calls = [
      { tool_use_id: "empty-write", tool_name: "Write", tool_input: { file_path: "empty.ts", content: "x" }, tool_response: "File written" },
      { tool_use_id: "empty-edit", tool_name: "Edit", tool_input: { file_path: "other.ts", old_string: "x", new_string: "y" }, tool_response: "File updated" },
    ]
    for (const call of calls) {
      await dispatchHook("PreToolUse", { session_id, cwd, tool_name: call.tool_name, tool_use_id: call.tool_use_id, tool_input: call.tool_input })
    }

    const empty = await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [] })
    expect(JSON.stringify(empty)).toContain("Reconciliation required")
    expect(new MutationIntentQueue(cwd, session_id).read()).toMatchObject({
      pending: [{ toolUseId: "empty-write" }, { toolUseId: "empty-edit" }],
      unresolved: { toolUseIds: ["empty-write", "empty-edit"] },
    })
    expect(await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "blocked", tool_input: { file_path: "blocked.ts" } }))
      .toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(JSON.stringify(await dispatchHook("SessionStart", { session_id, cwd, source: "resume" }))).toContain("Reconciliation required")

    await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: calls })
    await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: calls })
    const state = store.read(session_id)!
    expect(state.trace.verifications).toHaveLength(1)
    expect(state.trace.writes.map((write) => write.file)).toEqual(["empty.ts", "other.ts"])
    expect(readFileSync(join(cwd, ".parallax", "verification-ledger.jsonl"), "utf8").trim().split("\n")).toHaveLength(1)
    expect(new MutationIntentQueue(cwd, session_id).read()).toMatchObject({ pending: [], active: null, unresolved: null })
  })

  it("ignores an empty official batch when no mutation work exists", async () => {
    const cwd = temporary()
    const session_id = "genuinely-empty-batch-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    expect(await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [] })).toEqual({})
    expect(new MutationIntentQueue(cwd, session_id).read()).toMatchObject({ pending: [], active: null, unresolved: null })
  })

  it("does not record automatic evidence when ledger append fails", async () => {
    const cwd = temporary()
    const session_id = "ledger-failure-session"
    await dispatchHook("SessionStart", { session_id, cwd })
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "ledger-write", tool_input: { file_path: "unrecorded.ts" } })
    writeFileSync(join(cwd, ".parallax", "verification-ledger.jsonl"), '{"schemaVersion":2')

    await expect(dispatchHook("PostToolBatch", {
      session_id,
      cwd,
      tool_calls: [{ tool_use_id: "ledger-write", tool_name: "Write", tool_input: { file_path: "unrecorded.ts" }, tool_response: "File written" }],
    })).rejects.toThrow(/torn final line/i)

    const state = store.read(session_id)!
    expect(state.trace.verifications).toEqual([])
    expect(state.trace.writes).toEqual([])
    expect(state.friction.trials).toBe(0)
    expect(new MutationIntentQueue(cwd, session_id).read().active?.intents.map((intent) => intent.toolUseId)).toEqual(["ledger-write"])
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
    const store = new SessionStore(cwd)
    store.update(session_id, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "broken-write", tool_input: { file_path: "broken.ts" } })
    const output = await dispatchHook("PostToolBatch", {
      session_id,
      cwd,
      tool_calls: [{ tool_use_id: "broken-write", tool_name: "Write", tool_input: { file_path: "broken.ts" }, tool_response: "File written" }],
    })
    expect(JSON.stringify(output)).toContain("Recover:")
    expect(JSON.stringify(output)).toContain("batch-check-failed")
    const state = store.read(session_id)!
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
    const checkpointStore = new SessionStore(cwd)
    checkpointStore.update(session_id, (current) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) if (!current!.protocol.completed[step]) checkIn(current!, step, `${step} evidence`)
      return current!
    })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "after-checkpoint", tool_input: { file_path: "after-checkpoint.ts" } })
    await dispatchHook("PostToolBatch", { session_id, cwd, tool_calls: [{ tool_use_id: "after-checkpoint", tool_name: "Write", tool_input: { file_path: "after-checkpoint.ts" }, tool_response: "File written" }] })
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
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Write", tool_use_id: "ok", tool_input: { file_path: "ok.ts" } })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Edit", tool_use_id: "denied", tool_input: { file_path: "denied.ts" } })
    await dispatchHook("PreToolUse", { session_id, cwd, tool_name: "Bash", tool_use_id: "failed", tool_input: { command: "exit 1" } })
    await dispatchHook("PostToolBatch", {
      session_id, cwd,
      tool_calls: [
        { tool_use_id: "ok", tool_name: "Write", tool_input: { file_path: "ok.ts" }, tool_response: "File written" },
        { tool_use_id: "denied", tool_name: "Edit", tool_input: { file_path: "denied.ts" }, tool_response: "Permission denied" },
        { tool_use_id: "failed", tool_name: "Bash", tool_input: { command: "exit 1" }, tool_response: [{ type: "text", text: "Command failed" }] },
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
