import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { featureVerificationDigest } from "../src/horizon.js"
import { HorizonDispatchStore, type HorizonDispatchRole } from "../src/horizon-dispatch.js"
import { VerificationLedger } from "../src/ledger.js"
import { ParallaxMcpServer } from "../src/mcp.js"
import { createVerificationRecord } from "../src/trace.js"
import { TestWorkspace, horizonPlan } from "./fixtures.js"

const workspaces: TestWorkspace[] = []
function workspace(label: string): TestWorkspace {
  const value = new TestWorkspace(label)
  workspaces.push(value)
  return value
}
afterEach(() => { while (workspaces.length) workspaces.pop()!.cleanup() })

function text(result: Awaited<ReturnType<ParallaxMcpServer["callTool"]>>): string {
  return result.content[0]!.text
}

function appendPass(projectRoot: string, childRunId: string, startedAt?: string): string {
  const receipt = createVerificationRecord({
    sessionId: childRunId, source: "manual", command: "node", args: ["--test"], cwd: projectRoot, timeoutMs: 100,
    durationMs: 1, exitCode: 0, verdict: "pass", changedFiles: [], stdout: "ok", stderr: "", combined: "ok",
    outputTruncated: false, timedOut: false, skipReason: null,
   }, { startedAt })
  new VerificationLedger(projectRoot).append(receipt)
  return receipt.id
}

function completeDispatch(projectRoot: string, parentSessionId: string, horizonSessionId: string, role: HorizonDispatchRole, childRunId: string): void {
  const dispatches = new HorizonDispatchStore(projectRoot)
  dispatches.acquire({ parentSessionId, horizonSessionId, featureId: "f1", role, toolUseId: `${parentSessionId}-tool` })
  dispatches.bind(parentSessionId, childRunId)
  dispatches.observeStop(parentSessionId, childRunId)
  dispatches.observeAgentCompleted(parentSessionId, childRunId)
}

describe("MCP tool contract matrix", () => {
  it("publishes closed object schemas with unique names and useful descriptions", () => {
    const server = new ParallaxMcpServer({ projectRoot: workspace("schemas").root, horizonRoot: workspace("horizon").root })
    const tools = server.listTools()
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length)
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false })
      expect(tool.name).toMatch(/^(?:parallax|horizon)_[a-z_]+$/)
    }
  })

  it("enforces ordered check-ins and exposes deterministic trace views", async () => {
    const root = workspace("tool-protocol").root
    const server = new ParallaxMcpServer({ projectRoot: root, horizonRoot: workspace("tool-horizon").root })
    server.sessions.initialize("tools", root)

    const early = await server.callTool("parallax_checkin", { sessionId: "tools", step: "gate", evidence: "Tests are concrete" })
    expect(early.isError).toBe(true)
    expect(text(early)).toContain("Complete invariants before gate")

    for (const [step, evidence] of [
      ["ambiguity", "No material ambiguity remains"],
      ["invariants", "State ownership and timing are explicit"],
      ["gate", "The deterministic tests falsify regressions"],
    ]) {
      expect((await server.callTool("parallax_checkin", { sessionId: "tools", step, evidence })).isError).not.toBe(true)
    }
    await server.callTool("parallax_analyze", { sessionId: "tools", topic: "path traversal" })
    const view = await server.callTool("parallax_trace_view", { sessionId: "tools" })
    expect(text(view)).toContain("[x] ambiguity")
    expect(server.sessions.read("tools")!.trace.phases).toContainEqual(expect.objectContaining({ data: { analysisTopic: "path traversal" } }))
    expect(text(await server.callTool("parallax_trace_pr_comment", { sessionId: "tools" }))).toContain("## Parallax Trace")
  })

  it("round-trips every durable Horizon artifact through native tools", async () => {
    const server = new ParallaxMcpServer({ projectRoot: workspace("horizon-project").root, horizonRoot: workspace("horizon-store").root })
    expect((await server.callTool("horizon_init_session", { sessionId: "h-tools", goal: "Tool matrix" })).isError).not.toBe(true)
    expect((await server.callTool("horizon_write_plan", { sessionId: "h-tools", planJson: horizonPlan("h-tools") })).isError).not.toBe(true)

    const state = server.horizon.readState("h-tools")!
    state.currentPhase = "execute"
    expect((await server.callTool("horizon_write_state", { sessionId: "h-tools", stateJson: state })).isError).not.toBe(true)
    expect((await server.callTool("horizon_append_decision", {
      sessionId: "h-tools", feature: "f1", ambiguity: "Fixture choice", researchResult: "Source inspected",
      decision: "Use the fixture", rationale: "It is deterministic", confidence: "high",
    })).isError).not.toBe(true)
    expect((await server.callTool("horizon_write_research", { sessionId: "h-tools", findings: "Evidence", sourcesJson: { docs: "local" } })).isError).not.toBe(true)
    expect((await server.callTool("horizon_create_skill", { sessionId: "h-tools", name: "fixture-skill", description: "Safe fixture", content: "# Fixture" })).isError).not.toBe(true)
    expect((await server.callTool("horizon_save_trace", { sessionId: "h-tools", subAgentSessionId: "agent-1", traceData: { result: "ok" } })).isError).not.toBe(true)

    const status = await server.callTool("horizon_session_status", { sessionId: "h-tools" })
    expect(text(status)).toContain("Skills: 1")
    expect(text(status)).toContain("Traces: 1")
    expect(text(await server.callTool("horizon_list_skills", { sessionId: "h-tools" }))).toContain("fixture-skill")
    expect(text(await server.callTool("horizon_read_decisions", { sessionId: "h-tools" }))).toContain("Use the fixture")
    expect(text(await server.callTool("horizon_read_research", { sessionId: "h-tools" }))).toContain("Evidence")
  })

  it("enforces configured Horizon retries, independently verified completion, and confidence pauses", async () => {
    const projectRoot = workspace("horizon-invariants-project").root
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(1)\"" } }))
    const server = new ParallaxMcpServer({ projectRoot, horizonRoot: workspace("horizon-invariants-store").root })
    await server.callTool("horizon_config", { configJson: { autonomyLevel: "semi", maxRetryCycles: 2, decisionConfidenceThreshold: 0.8 } })
    await server.callTool("horizon_init_session", { sessionId: "configured", goal: "Invariant matrix" })
    expect(server.horizon.readPlan("configured")!.autonomyLevel).toBe("semi")
    expect((await server.callTool("horizon_write_plan", { sessionId: "configured", planJson: horizonPlan("configured") })).isError).toBe(true)
    expect((await server.callTool("horizon_write_plan", { sessionId: "configured", planJson: horizonPlan("configured", { maxAttempts: 2 }) })).isError).not.toBe(true)
    const forged = structuredClone(server.horizon.readPlan("configured")!)
    forged.milestones[0]!.features[0]!.verification = { passed: true, score: 100, testResults: "claimed pass", issues: [], featureDigest: "0".repeat(64) }
    expect((await server.callTool("horizon_write_plan", { sessionId: "configured", planJson: forged })).isError).toBe(true)
    const beforeRevision = server.horizon.readPlan("configured")!
    const staleDigest = featureVerificationDigest(beforeRevision.goal, beforeRevision.milestones[0]!.features[0]!)
    const revisedBeforeCheck = structuredClone(beforeRevision)
    revisedBeforeCheck.milestones[0]!.features[0]!.acceptanceCriteria = "Revised before the verifier completed"
    expect((await server.callTool("horizon_write_plan", { sessionId: "configured", planJson: revisedBeforeCheck })).isError).not.toBe(true)
    expect(() => server.horizon.recordEvaluation("configured", "f1", { passed: false, score: 0, testResults: "failed", issues: ["failed"] }, staleDigest)).toThrow(/changed while verification was running/)
    expect((await server.callTool("horizon_update_feature", { sessionId: "configured", featureId: "f1", status: "completed" })).isError).toBe(true)
    const failedVerification = await server.callTool("horizon_evaluate_subagent", { sessionId: "configured", featureId: "f1", protocolIntegrity: 100, correctness: 100, designQuality: 100, edgeCaseCoverage: 100, userPerspective: 100 })
    expect(text(failedVerification)).toContain("FAIL")
    expect(server.horizon.readPlan("configured")!.milestones[0]!.features[0]!.verification.passed).toBe(false)
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }))
    await server.callTool("horizon_evaluate_subagent", { sessionId: "configured", featureId: "f1", protocolIntegrity: 100, correctness: 100, designQuality: 100, edgeCaseCoverage: 100, userPerspective: 100 })
    const changedRevision = structuredClone(server.horizon.readPlan("configured")!)
    changedRevision.milestones[0]!.features[0]!.acceptanceCriteria = "A materially different feature"
    expect((await server.callTool("horizon_write_plan", { sessionId: "configured", planJson: changedRevision })).isError).toBe(true)
    expect((await server.callTool("horizon_update_feature", { sessionId: "configured", featureId: "f1", status: "completed" })).isError).toBe(true)
    expect(server.horizon.readPlan("configured")!.milestones[0]!.features[0]!).toMatchObject({ status: "pending", verification: { passed: false }, evidence: { worker: { receipt: null } } })
    await server.callTool("horizon_append_decision", { sessionId: "configured", feature: "f1", ambiguity: "Low confidence choice", researchResult: "insufficient", decision: "pause", rationale: "threshold", confidence: "low" })
    expect(server.horizon.readState("configured")!.pauseReason).toContain("below configured threshold")
  })

  it("requires explicit milestone approval when auto-approval is disabled and then finalizes consistently", async () => {
    const projectRoot = workspace("approval-project").root
    writeFileSync(join(projectRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }))
    const server = new ParallaxMcpServer({ projectRoot, horizonRoot: workspace("approval-store").root })
    await server.callTool("horizon_config", { configJson: { autoApproveMilestones: false } })
    await server.callTool("horizon_init_session", { sessionId: "approval", goal: "Manual approval" })
    await server.callTool("horizon_write_plan", { sessionId: "approval", planJson: horizonPlan("approval") })
    await server.callTool("horizon_begin_worker", { sessionId: "approval", featureId: "f1", childRunId: "approval-worker" })
    const receiptId = appendPass(projectRoot, "approval-worker", server.horizon.readActiveChild("approval")!.acquiredAt)
    expect((await server.callTool("horizon_observe_receipt", { sessionId: "approval", parentSessionId: "approval-parent-worker", featureId: "f1", childRunId: "approval-worker", receiptId, summary: "premature" })).isError).toBe(true)
    completeDispatch(projectRoot, "approval-parent-worker", "approval", "worker", "approval-worker")
    const observed = await server.callTool("horizon_observe_receipt", { sessionId: "approval", parentSessionId: "approval-parent-worker", featureId: "f1", childRunId: "approval-worker", receiptId, summary: "worker complete" })
    expect(observed.isError, text(observed)).not.toBe(true)
    const auditor = await server.callTool("horizon_begin_auditor", { sessionId: "approval", featureId: "f1", childRunId: "approval-auditor" })
    expect(auditor.isError, text(auditor)).not.toBe(true)
    completeDispatch(projectRoot, "approval-parent-auditor", "approval", "auditor", "approval-auditor")
    const audit = await server.callTool("horizon_record_audit", { sessionId: "approval", parentSessionId: "approval-parent-auditor", featureId: "f1", childRunId: "approval-auditor", verdict: "accept", summary: "accepted" })
    expect(audit.isError, text(audit)).not.toBe(true)
    expect(server.horizon.readPlan("approval")).toMatchObject({ status: "executing", milestones: [{ status: "in_progress", features: [{ status: "completed" }] }] })
    expect((await server.callTool("horizon_write_state", { sessionId: "approval", stateJson: { currentPhase: "complete" } })).isError).toBe(true)
    expect((await server.callTool("horizon_update_milestone", { sessionId: "approval", milestoneId: "m1", status: "completed" })).isError).not.toBe(true)
    expect(server.horizon.readPlan("approval")!.status).toBe("completed")
    expect(server.horizon.readState("approval")!.currentPhase).toBe("complete")
  })

  it("fails closed when recovering active children unless identity and dead-child evidence match", async () => {
    const horizonRoot = workspace("recovery-tool-store").root
    const server = new ParallaxMcpServer({ projectRoot: workspace("recovery-tool-project").root, horizonRoot })
    await server.callTool("horizon_init_session", { sessionId: "recovery", goal: "Recovery" })
    await server.callTool("horizon_write_plan", { sessionId: "recovery", planJson: horizonPlan("recovery") })
    await server.callTool("horizon_begin_worker", { sessionId: "recovery", featureId: "f1", childRunId: "worker-1" })
    const lockPath = join(horizonRoot, "sessions", "recovery", "active-child.json")
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>; lock.leaseUntil = "2000-01-01T00:00:00.000Z"; writeFileSync(lockPath, JSON.stringify(lock))

    expect(text(await server.callTool("horizon_recover_active_child", { sessionId: "recovery", expectedFeatureId: "wrong", expectedChildRunId: "worker-1", childAlive: false }))).toMatch(/identity mismatch/i)
    expect(text(await server.callTool("horizon_recover_active_child", { sessionId: "recovery", expectedFeatureId: "f1", expectedChildRunId: "worker-1" }))).toMatch(/liveness evidence/i)
    expect((await server.callTool("horizon_recover_active_child", { sessionId: "recovery", expectedFeatureId: "f1", expectedChildRunId: "worker-1", childAlive: false })).isError).not.toBe(true)
    expect(server.horizon.readActiveChild("recovery")).toBeNull()
  })

  it("ledgers automatic evidence before mutating Horizon evaluation artifacts and fails closed", async () => {
    const successRoot = workspace("evaluation-ledger-success").root
    writeFileSync(join(successRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }))
    const success = new ParallaxMcpServer({ projectRoot: successRoot, horizonRoot: workspace("evaluation-ledger-success-store").root })
    await success.callTool("horizon_init_session", { sessionId: "ledger-success", goal: "Ledger success" })
    await success.callTool("horizon_write_plan", { sessionId: "ledger-success", planJson: horizonPlan("ledger-success") })
    const evaluated = await success.callTool("horizon_evaluate_subagent", { sessionId: "ledger-success", featureId: "f1", protocolIntegrity: 100, correctness: 100, designQuality: 100, edgeCaseCoverage: 100, userPerspective: 100 })
    expect(evaluated.isError).not.toBe(true)
    expect(new VerificationLedger(successRoot).read()).toMatchObject([{ sessionId: "ledger-success", source: "automatic", verdict: "pass" }])
    expect(success.horizon.readPlan("ledger-success")!.milestones[0]!.features[0]!).toMatchObject({ verification: { passed: false }, evidence: { worker: { receipt: null } } })
    expect(success.horizon.readDecisions("ledger-success")).toHaveLength(1)

    const failureRoot = workspace("evaluation-ledger-failure").root
    writeFileSync(join(failureRoot, "package.json"), JSON.stringify({ scripts: { check: "node -e \"process.exit(0)\"" } }))
    const failure = new ParallaxMcpServer({ projectRoot: failureRoot, horizonRoot: workspace("evaluation-ledger-failure-store").root })
    await failure.callTool("horizon_init_session", { sessionId: "ledger-failure", goal: "Ledger failure" })
    await failure.callTool("horizon_write_plan", { sessionId: "ledger-failure", planJson: horizonPlan("ledger-failure") })
    const ledger = new VerificationLedger(failureRoot)
    mkdirSync(dirname(ledger.path), { recursive: true })
    writeFileSync(ledger.path, '{"schemaVersion":2')
    const planBefore = failure.horizon.readPlan("ledger-failure")
    const decisionsBefore = failure.horizon.readDecisions("ledger-failure")
    const rejected = await failure.callTool("horizon_evaluate_subagent", { sessionId: "ledger-failure", featureId: "f1", protocolIntegrity: 100, correctness: 100, designQuality: 100, edgeCaseCoverage: 100, userPerspective: 100 })
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toMatch(/torn final line/i)
    expect(failure.horizon.readPlan("ledger-failure")).toEqual(planBefore)
    expect(failure.horizon.readDecisions("ledger-failure")).toEqual(decisionsBefore)
  })

  it("returns input and protocol errors as MCP tool results", async () => {
    const server = new ParallaxMcpServer({ projectRoot: workspace("errors").root, horizonRoot: workspace("error-horizon").root })
    expect((await server.callTool("not_a_tool", {})).isError).toBe(true)
    expect((await server.callTool("parallax_hyperplan", [])).isError).toBe(true)
    expect(text(await server.callTool("parallax_hyperplan", { mode: "bad", plan: "a complex API migration" }))).toContain("Unknown mode")
    expect(text(await server.callTool("horizon_init_session", { sessionId: "../bad", goal: "bad" }))).toContain("Invalid session ID")
  })

  it("supports all Hyperplan rounds with deterministic fixtures", async () => {
    const server = new ParallaxMcpServer({ projectRoot: workspace("hyperplan").root, horizonRoot: workspace("hyperplan-h").root })
    const plan = "Migrate an authenticated API and database with concurrent workers and retry handling."
    const analysis = await server.callTool("parallax_hyperplan", { mode: "generate", round: "analysis", plan, force: true })
    expect(text(analysis)).toContain("ROUND 1: ANALYSIS")
    const crossAttack = await server.callTool("parallax_hyperplan", { mode: "generate", round: "cross-attack", plan, force: true, angles: ["sentinel"], findings: [{ angleId: "sentinel", angleName: "Sentinel", findings: "Retries can loop forever" }] })
    expect(text(crossAttack)).toContain("ROUND 2: CROSS-ATTACK")
    const defense = await server.callTool("parallax_hyperplan", { mode: "generate", round: "defense", plan, force: true, angles: ["sentinel"], attacks: { sentinel: [{ targetFinding: "Retries can loop forever", attackerName: "Pragmatist", attack: "Cap them", severity: "critical" }] } })
    expect(text(defense)).toContain("ROUND 3: DEFENSE")
    const synthesis = await server.callTool("parallax_hyperplan", { mode: "synthesize", plan, critiques: [{
      angleId: "sentinel", angleName: "Sentinel", findings: "Bound retries", severity: "critical", affectedAreas: ["worker"],
    }] })
    expect(text(synthesis)).toContain("Hard Constraints")
  })
})
