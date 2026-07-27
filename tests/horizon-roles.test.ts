import { readFileSync, writeFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import { dispatchHook } from "../src/hook.js"
import { HorizonDispatchStore } from "../src/horizon-dispatch.js"
import { HorizonStore } from "../src/horizon.js"
import { VerificationLedger } from "../src/ledger.js"
import { checkIn } from "../src/protocol.js"
import { SessionStore } from "../src/state.js"
import { createVerificationRecord } from "../src/trace.js"
import { horizonPlan, TestWorkspace } from "./fixtures.js"

const workspaces: TestWorkspace[] = []
const priorHome = process.env.PARALLAX_HORIZON_HOME
function workspace(label: string): TestWorkspace { const value = new TestWorkspace(label); workspaces.push(value); return value }
afterEach(() => {
  while (workspaces.length) workspaces.pop()!.cleanup()
  if (priorHome === undefined) delete process.env.PARALLAX_HORIZON_HOME
  else process.env.PARALLAX_HORIZON_HOME = priorHome
})

const WORKER = "parallax-claudecode:horizon-worker"
const AUDITOR = "parallax-claudecode:horizon-auditor"
const SUPERVISOR = "parallax-claudecode:horizon"
const MCP = "mcp__plugin_parallax-claudecode_parallax__"
function prompt(sessionId: string, featureId = "f1"): string { return `HORIZON_DISPATCH {"sessionId":"${sessionId}","featureId":"${featureId}"}\nAtomic brief` }

describe("Claude Horizon role lifecycle", () => {
  it("rejects an unbound human brief with the valid dispatch format", async () => {
    const project = workspace("unbound-dispatch-project")
    const parent = "unbound-dispatch-session"
    await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })
    const result = await dispatchHook("PreToolUse", {
      session_id: parent,
      cwd: project.root,
      tool_name: "Agent",
      tool_use_id: "unbound-worker",
      tool_input: { subagent_type: WORKER, prompt: "Repair E2E activation fake" },
    })
    const reason = (result.hookSpecificOutput as Record<string, unknown>).permissionDecisionReason as string
    expect(reason).toContain('HORIZON_DISPATCH {"sessionId":"<horizon-session>","featureId":"<feature>"}')
    expect(reason).toContain("Do not dispatch a worker with only a human brief")
  })

  it("binds one worker, requires completed evidence and receipt, then binds a distinct read-only auditor", async () => {
    const project = workspace("roles-project"); const home = workspace("roles-home")
    process.env.PARALLAX_HORIZON_HOME = home.root
    const horizon = new HorizonStore(home.root); horizon.initSession("h1", "Role lifecycle"); horizon.writePlan("h1", horizonPlan("h1"))
    const parent = "parent-role-session"; await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })

    const reserved = await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "agent-call-worker", tool_input: { subagent_type: WORKER, prompt: prompt("h1"), description: "foreground worker" } })
    expect(JSON.stringify(reserved)).toContain("dispatch reserved")
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "overlap", tool_input: { subagent_type: WORKER, prompt: prompt("h1"), description: "overlap" } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    await dispatchHook("SubagentStart", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: "worker-1" })
    expect(horizon.readActiveChild("h1")).toMatchObject({ role: "worker", childRunId: "worker-1" })

    const prematureObserve = { sessionId: "h1", parentSessionId: parent, featureId: "f1", childRunId: "worker-1", receiptId: "not-ready", summary: "premature" }
    for (const identity of [{}, { agent_type: SUPERVISOR, agent_id: "supervisor-1" }]) {
      expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_observe_receipt`, tool_input: prematureObserve, ...identity })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    }

    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", agent_type: WORKER, agent_id: "worker-1", tool_input: { subagent_type: "general-purpose" } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_record_audit`, agent_type: WORKER, agent_id: "worker-1", tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })

    const longSummary = "x".repeat(2_100)
    await dispatchHook("SubagentStop", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: "worker-1", agent_transcript_path: "trace.jsonl", last_assistant_message: longSummary })
    await dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "agent-call-worker", tool_response: { status: "completed", agentId: "worker-1" } })
    expect((JSON.parse(readFileSync(`${home.root}/sessions/h1/traces/worker-1.json`, "utf8")) as { summary: string }).summary).toHaveLength(2_000)

    const startedAt = horizon.readPlan("h1")!.milestones[0]!.features[0]!.evidence.worker.startedAt!
    const receipt = createVerificationRecord({ sessionId: "worker-1", source: "manual", command: "node", args: ["--test"], cwd: project.root, timeoutMs: 100, durationMs: 0, exitCode: 0, verdict: "pass", changedFiles: [], stdout: "pass", stderr: "", combined: "pass", outputTruncated: false, timedOut: false, skipReason: null }, { startedAt })
    new VerificationLedger(project.root).append(receipt)
    const observeInput = { sessionId: "h1", parentSessionId: parent, featureId: "f1", childRunId: "worker-1", receiptId: receipt.id, summary: "worker complete" }
    for (const tool_input of [
      { ...observeInput, parentSessionId: "wrong-parent" },
      { ...observeInput, sessionId: "wrong-session" },
      { ...observeInput, featureId: "wrong-feature" },
      { ...observeInput, childRunId: "wrong-child" },
    ]) expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_observe_receipt`, agent_type: SUPERVISOR, agent_id: "supervisor-1", tool_input })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_record_audit`, agent_type: SUPERVISOR, agent_id: "supervisor-1", tool_input: observeInput })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect((await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_observe_receipt`, agent_type: SUPERVISOR, agent_id: "supervisor-1", tool_input: observeInput })).hookSpecificOutput).not.toMatchObject({ permissionDecision: "deny" })
    horizon.observeReceipt(project.root, "h1", "f1", receipt.id, "worker complete")
    await dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_observe_receipt`, tool_input: observeInput, tool_response: "observed" })
    expect(new HorizonDispatchStore(project.root).read(parent)).toBeNull()
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_observe_receipt`, tool_input: observeInput })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })

    await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "agent-call-auditor", tool_input: { subagent_type: AUDITOR, prompt: prompt("h1"), description: "foreground auditor" } })
    await dispatchHook("SubagentStart", { session_id: parent, cwd: project.root, agent_type: AUDITOR, agent_id: "auditor-1" })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}parallax_verify`, agent_type: AUDITOR, agent_id: "auditor-1", tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    await dispatchHook("SubagentStop", { session_id: parent, cwd: project.root, agent_type: AUDITOR, agent_id: "auditor-1", last_assistant_message: "accept" })
    await dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "agent-call-auditor", tool_response: { status: "completed", agent_id: "auditor-1" } })
    const auditInput = { sessionId: "h1", parentSessionId: parent, featureId: "f1", childRunId: "auditor-1", verdict: "accept", summary: "accepted" }
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_record_audit`, tool_input: auditInput })).not.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    horizon.recordAudit("h1", "f1", "auditor-1", "accept", "accepted")
    await dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_record_audit`, tool_input: auditInput, tool_response: "recorded" })
    expect(horizon.readPlan("h1")!.milestones[0]!.features[0]!.status).toBe("completed")
  })

  it("authorizes the scoped supervisor and main thread while denying unrelated delegated agents", async () => {
    const project = workspace("role-auth-project"); const home = workspace("role-auth-home")
    process.env.PARALLAX_HORIZON_HOME = home.root
    const horizon = new HorizonStore(home.root); horizon.initSession("auth", "Auth"); horizon.writePlan("auth", horizonPlan("auth"))
    const parent = "parent-auth-session"; await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })
    const tool = `${MCP}horizon_list_sessions`
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: tool, agent_type: SUPERVISOR, agent_id: "supervisor-1", tool_input: {} })).not.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: tool, tool_input: {} })).not.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_read_plan`, agent_type: SUPERVISOR, agent_id: "supervisor-1", tool_input: { sessionId: "auth" } })).not.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: tool, agent_type: "general-purpose", agent_id: "random-1", tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: tool, agent_type: "random-role", tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: tool, agent_id: "orphan-id", tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: tool, agent_type: SUPERVISOR, tool_input: {} })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "random-dispatch", agent_type: "general-purpose", agent_id: "random-1", tool_input: { subagent_type: WORKER, prompt: prompt("auth") } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "random-no-id", agent_type: "general-purpose", tool_input: { subagent_type: WORKER, prompt: prompt("auth") } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "main-dispatch", tool_input: { subagent_type: WORKER, prompt: prompt("auth") } })).not.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
  })

  it.each(["Write", "Bash"])("authorizes %s mutations only for main or the correlated active worker", async (tool) => {
    const project = workspace(`mutation-auth-project-${tool}`); const home = workspace(`mutation-auth-home-${tool}`)
    process.env.PARALLAX_HORIZON_HOME = home.root
    const horizon = new HorizonStore(home.root); horizon.initSession(`mutation-${tool}`, "Mutation identity"); horizon.writePlan(`mutation-${tool}`, horizonPlan(`mutation-${tool}`))
    const parent = `parent-mutation-${tool}`; await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })
    new SessionStore(project.root).update(parent, (state) => {
      for (const step of ["ambiguity", "invariants", "gate"] as const) checkIn(state!, step, `${step} evidence`)
      return state!
    })
    const tool_input = tool === "Write" ? { file_path: `${tool}.ts` } : { command: "echo ok" }
    const call = (label: string, identity: Record<string, string> = {}) => dispatchHook("PreToolUse", {
      session_id: parent, cwd: project.root, tool_name: tool, tool_use_id: `${tool}-${label}`, tool_input, ...identity,
    })

    expect(await call("main")).not.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: `dispatch-${tool}`, tool_input: { subagent_type: WORKER, prompt: prompt(`mutation-${tool}`) } })
    await dispatchHook("SubagentStart", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: `worker-${tool}` })
    expect(await call("worker", { agent_type: WORKER, agent_id: `worker-${tool}` })).not.toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })

    for (const [label, identity] of [
      ["auditor", { agent_type: AUDITOR, agent_id: `auditor-${tool}` }],
      ["random-complete", { agent_type: "general-purpose", agent_id: `random-${tool}` }],
      ["random-partial", { agent_type: "general-purpose" }],
      ["recognized-partial", { agent_type: WORKER }],
      ["orphan-id", { agent_id: `orphan-${tool}` }],
      ["mismatched-child", { agent_type: WORKER, agent_id: `wrong-${tool}` }],
      ["supervisor", { agent_type: SUPERVISOR, agent_id: `supervisor-${tool}` }],
    ] as const) {
      expect(await call(label, identity)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    }
  })

  it("quarantines default-background launches, retains overlap lock, and releases only after dead-child recovery", async () => {
    const project = workspace("role-blocks-project"); const home = workspace("role-blocks-home")
    process.env.PARALLAX_HORIZON_HOME = home.root
    const horizon = new HorizonStore(home.root); horizon.initSession("h2", "Blocks"); horizon.writePlan("h2", horizonPlan("h2"))
    const parent = "parent-block-session"; await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })
    for (const tool_input of [
      { subagent_type: "horizon-worker", prompt: prompt("h2") },
      { subagent_type: WORKER, prompt: prompt("h2"), run_in_background: true },
    ]) expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: `call-${Math.random()}`, tool_input })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })

    await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "async-call", tool_input: { subagent_type: WORKER, prompt: prompt("h2") } })
    await dispatchHook("SubagentStart", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: "worker-async" })
    const rejected = await dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "async-call", tool_response: { status: "async_launched", agentId: "worker-async" } })
    expect(JSON.stringify(rejected)).toContain("no supported foreground guarantee")
    expect(horizon.readActiveChild("h2")).toMatchObject({ childRunId: "worker-async" })
    expect(new HorizonDispatchStore(project.root).read(parent)).toMatchObject({ status: "quarantined", stopObserved: false, agentCompleted: false })
    expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "overlap-async", tool_input: { subagent_type: WORKER, prompt: prompt("h2") } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
    await dispatchHook("SubagentStop", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: "worker-async", last_assistant_message: "done in background" })
    expect(new HorizonDispatchStore(project.root).read(parent)).toMatchObject({ status: "quarantined", stopObserved: true, agentCompleted: false })
    const lockPath = `${home.root}/sessions/h2/active-child.json`
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>; lock.leaseUntil = "2000-01-01T00:00:00.000Z"; writeFileSync(lockPath, JSON.stringify(lock))
    horizon.recoverActiveChild("h2", "f1", "worker-async", false)
    await dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_recover_active_child`, tool_response: "recovered" })
    expect(horizon.readActiveChild("h2")).toBeNull()
    expect(new HorizonDispatchStore(project.root).read(parent)).toBeNull()
    expect(horizon.readPlan("h2")!.milestones[0]!.features[0]!.status).toBe("pending")
  })

  it("requires matching stop and Agent completion in either order before transitions become ready", async () => {
    const exercise = async (label: string, agentFirst: boolean): Promise<void> => {
      const project = workspace(`dual-project-${label}`); const home = workspace(`dual-home-${label}`)
      process.env.PARALLAX_HORIZON_HOME = home.root
      const horizon = new HorizonStore(home.root); horizon.initSession(label, "Dual evidence"); horizon.writePlan(label, horizonPlan(label))
      const parent = `parent-${label}`; const agent = `worker-${label}`; await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })
      await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: `call-${label}`, tool_input: { subagent_type: WORKER, prompt: prompt(label) } })
      await dispatchHook("SubagentStart", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: agent })
      const completed = () => dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: `call-${label}`, tool_response: { status: "completed", [agentFirst ? "agentId" : "agent_id"]: agent } })
      const stopped = () => dispatchHook("SubagentStop", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: agent, last_assistant_message: "done" })
      await (agentFirst ? completed() : stopped())
      expect(new HorizonDispatchStore(project.root).read(parent)?.status).toBe("bound")
      expect(await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_observe_receipt`, tool_input: { sessionId: label, parentSessionId: parent, featureId: "f1", childRunId: agent } })).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } })
      await (agentFirst ? stopped() : completed())
      expect(new HorizonDispatchStore(project.root).read(parent)).toMatchObject({ status: "completed", stopObserved: true, agentCompleted: true })
    }
    await exercise("agent-first", true)
    await exercise("stop-first", false)
  })

  it("fails closed on mismatched lifecycle identity and quarantines Agent failure until recovery", async () => {
    const project = workspace("mismatch-project"); const home = workspace("mismatch-home")
    process.env.PARALLAX_HORIZON_HOME = home.root
    const horizon = new HorizonStore(home.root); horizon.initSession("mismatch", "Mismatch"); horizon.writePlan("mismatch", horizonPlan("mismatch"))
    const parent = "parent-mismatch"; await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })
    await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "call-mismatch", tool_input: { subagent_type: WORKER, prompt: prompt("mismatch") } })
    await dispatchHook("SubagentStart", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: "worker-right" })
    await expect(dispatchHook("SubagentStop", { session_id: parent, cwd: project.root, agent_type: AUDITOR, agent_id: "worker-right" })).rejects.toThrow(/reserved role|identity did not match/)
    await expect(dispatchHook("SubagentStop", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: "worker-wrong" })).rejects.toThrow(/identity did not match/)
    await dispatchHook("PostToolUseFailure", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "call-mismatch", tool_response: { agentId: "worker-right" }, error: "transport failed" })
    expect(new HorizonDispatchStore(project.root).read(parent)).toMatchObject({ status: "quarantined" })
    expect(horizon.readActiveChild("mismatch")).toMatchObject({ childRunId: "worker-right" })
    const lockPath = `${home.root}/sessions/mismatch/active-child.json`
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>; lock.leaseUntil = "2000-01-01T00:00:00.000Z"; writeFileSync(lockPath, JSON.stringify(lock))
    horizon.recoverActiveChild("mismatch", "f1", "worker-right", false)
    await dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: `${MCP}horizon_recover_active_child`, tool_response: "recovered" })
    expect(new HorizonDispatchStore(project.root).read(parent)).toBeNull()
    expect(horizon.readPlan("mismatch")!.milestones[0]!.features[0]!.status).toBe("pending")
  })

  it("quarantines unrelated or incomplete Agent completion evidence", async () => {
    for (const [label, payload] of [
      ["wrong-tool", { tool_use_id: "unrelated", tool_response: { status: "completed", agentId: "worker-correlation" } }],
      ["missing-tool", { tool_response: { status: "completed", agentId: "worker-correlation" } }],
      ["wrong-agent", { tool_use_id: "call-correlation", tool_response: { status: "completed", agentId: "worker-other" } }],
      ["missing-agent", { tool_use_id: "call-correlation", tool_response: { status: "completed" } }],
    ] as const) {
      const project = workspace(`correlation-project-${label}`); const home = workspace(`correlation-home-${label}`)
      process.env.PARALLAX_HORIZON_HOME = home.root
      const horizon = new HorizonStore(home.root); horizon.initSession(label, "Correlation"); horizon.writePlan(label, horizonPlan(label))
      const parent = `parent-${label}`; await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })
      await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "call-correlation", tool_input: { subagent_type: WORKER, prompt: prompt(label) } })
      await dispatchHook("SubagentStart", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: "worker-correlation" })
      await dispatchHook("PostToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", ...payload })
      expect(new HorizonDispatchStore(project.root).read(parent)).toMatchObject({ status: "quarantined", agentCompleted: false })
    }
  })

  it("quarantines Agent failures with missing or mismatched correlation", async () => {
    const project = workspace("failure-correlation-project"); const home = workspace("failure-correlation-home")
    process.env.PARALLAX_HORIZON_HOME = home.root
    const horizon = new HorizonStore(home.root); horizon.initSession("failure-correlation", "Failure correlation"); horizon.writePlan("failure-correlation", horizonPlan("failure-correlation"))
    const parent = "parent-failure-correlation"; await dispatchHook("SessionStart", { session_id: parent, cwd: project.root })
    await dispatchHook("PreToolUse", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "call-failure", tool_input: { subagent_type: WORKER, prompt: prompt("failure-correlation") } })
    await dispatchHook("SubagentStart", { session_id: parent, cwd: project.root, agent_type: WORKER, agent_id: "worker-failure" })
    await dispatchHook("PostToolUseFailure", { session_id: parent, cwd: project.root, tool_name: "Agent", tool_use_id: "wrong-call", tool_response: { agentId: "worker-failure" }, error: "failed" })
    expect(new HorizonDispatchStore(project.root).read(parent)).toMatchObject({ status: "quarantined", agentCompleted: false })
  })
})
