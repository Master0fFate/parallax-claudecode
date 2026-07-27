import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  HorizonStore,
  PARALLAX_SCHEMA_VERSION,
  SessionStore,
  addPhase,
  addWriteBatch,
  computeCoherenceScore,
  checkpointTrace,
  createSessionState,
  createVerificationRecord,
  detectProject,
  getVerifyCommands,
  validateHorizonPlan,
  validateSessionState,
} from "../src/index.js"
import type { HorizonPlan } from "../src/types.js"
import { FIXED_TIME, horizonPlan } from "./fixtures.js"

const roots: string[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "parallax-claude-test-"))
  roots.push(root)
  return root
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function plan(sessionId: string): HorizonPlan {
  return {
    schemaVersion: PARALLAX_SCHEMA_VERSION,
    sessionId,
    goal: "Build safely",
    autonomyLevel: "full",
    status: "planning",
    createdAt: new Date().toISOString(),
    completedAt: null,
    milestones: [{
      id: "m1", name: "Core", description: "", status: "pending", order: 1, requiresApproval: false,
      features: [{
        id: "f1", name: "State", description: "", acceptanceCriteria: "State is isolated", protocolLevel: "full",
        status: "pending", order: 1, subAgentSessionId: null, attempts: 0, maxAttempts: 3,
        verification: { passed: false, testResults: null, issues: [], score: null, featureDigest: null }, skillsRequired: [], skillsGenerated: [],
      evidence: {
        worker: { childRunId: null, startedAt: null, completedAt: null, receipt: null, summary: null, traceId: null },
        auditor: { childRunId: null, startedAt: null, completedAt: null, verdict: null, summary: null, traceId: null },
        history: [],
      },
      }],
    }],
    skills: { global: [], sessionScoped: [] },
    stats: { totalFeatures: 1, completedFeatures: 0, failedFeatures: 0, totalRetries: 0, estimatedCost: null },
  }
}

describe("session-safe core", () => {
  it("provides deterministic, non-shared fixtures", () => {
    const first = horizonPlan("fixture")
    const second = horizonPlan("fixture")
    first.milestones[0]!.features[0]!.name = "mutated"
    expect(second.createdAt).toBe(FIXED_TIME)
    expect(second.milestones[0]!.features[0]!.name).toBe("Feature one")
    expect(JSON.stringify(horizonPlan("fixture"))).toBe(JSON.stringify(horizonPlan("fixture")))
  })

  it("isolates state atomically by Claude session ID", () => {
    const root = temporary()
    const store = new SessionStore(root)
    store.initialize("session-a", root)
    store.initialize("session-b", root)
    store.update("session-a", (state) => {
      expect(state).not.toBeNull()
      state!.friction.retriesLeft = 1
      return state!
    })
    expect(store.read("session-a")!.friction.retriesLeft).toBe(1)
    expect(store.read("session-b")!.friction.retriesLeft).toBe(3)
    expect(store.pathFor("session-a")).not.toBe(store.pathFor("session-b"))
  })

  it("scores protocol ordering, unique edge topics, and non-skipped verification without inflation", () => {
    const state = createSessionState("score", temporary())
    for (const phase of ["ambiguity_check", "four_invariants", "verification_gate", "commit_decision", "summary"] as const) addPhase(state.trace, phase)
    for (const topic of ["Concurrency", "concurrency", "Rollback"]) addPhase(state.trace, "mode_switch", { analysisTopic: topic })
    state.trace.verifications.push(
      createVerificationRecord({ command: null, files: [], verdict: "skipped", exitCode: null, durationMs: 0, stdout: "", stderr: "" }),
      createVerificationRecord({ command: "test", files: [], verdict: "pass", exitCode: 0, durationMs: 1, stdout: "", stderr: "" }),
    )
    const score = computeCoherenceScore(state.trace)
    expect(score).toMatchObject({ protocolCoverage: 30, verificationIntegrity: 35, timingDiscipline: 15 })
    expect(score.edgeCaseCoverage).toBe(6)
    expect(score.total).toBeLessThanOrEqual(100)
  })

  it("fully validates nested trace fields and cross-record references", () => {
    const state = createSessionState("trace-validation", temporary())
    const verification = createVerificationRecord({ command: "test", files: ["a.ts"], verdict: "pass", exitCode: 0, durationMs: 1, stdout: "ok", stderr: "" })
    addWriteBatch(state.trace, ["a.ts", "b.ts"], "Edit", verification, 3)
    expect(state.trace.session.agentVersion).toBe("0.2.2")
    expect(validateSessionState(structuredClone(state))).toBeTruthy()
    const priorPatch = structuredClone(state)
    priorPatch.trace.session.agentVersion = "0.1.0"
    expect(validateSessionState(priorPatch)).toBeTruthy()
    const badPhase = structuredClone(state)
    badPhase.trace.phases.push({ phase: "summary", timestamp: "not-a-date", data: {} })
    expect(() => validateSessionState(badPhase)).toThrow(/phase record/)
    const badVerification = structuredClone(state)
    ;(badVerification.trace.verifications[0]! as unknown as { exitCode: number | null }).exitCode = 7
    expect(() => validateSessionState(badVerification)).toThrow(/verdict and exitCode/)
    const missingReference = structuredClone(state)
    missingReference.trace.writes[0]!.verificationId = "missing"
    expect(() => validateSessionState(missingReference)).toThrow(/missing verification/)
    const mismatchedVerdict = structuredClone(state)
    mismatchedVerdict.trace.writes[0]!.verification = "fail"
    expect(() => validateSessionState(mismatchedVerdict)).toThrow(/verdict does not match/)
    const inconsistentBatch = structuredClone(state)
    inconsistentBatch.trace.writes[1]!.tool = "Bash"
    expect(() => validateSessionState(inconsistentBatch)).toThrow(/batch records are internally inconsistent/)
    checkpointTrace(state.trace, state.friction.maxRetries)
    expect(validateSessionState(structuredClone(state))).toBeTruthy()
    const inflatedMetrics = structuredClone(state)
    inflatedMetrics.trace.metrics!.verificationPassRate = 0
    expect(() => validateSessionState(inflatedMetrics)).toThrow(/metrics do not match/)
    const forgedRetryPolicy = structuredClone(state)
    forgedRetryPolicy.trace.metrics!.maxRetries = 99
    expect(() => validateSessionState(forgedRetryPolicy)).toThrow(/maxRetries does not match/)
    const inflatedCoherence = structuredClone(state)
    inflatedCoherence.trace.coherenceScore = 100
    expect(() => validateSessionState(inflatedCoherence)).toThrow(/coherenceScore does not match/)
    const legacyCheckpoint = structuredClone(state)
    delete (legacyCheckpoint.trace.metrics as unknown as Record<string, unknown>).maxRetries
    delete (legacyCheckpoint.trace.metrics as unknown as Record<string, unknown>).computedAt
    const upgraded = validateSessionState(legacyCheckpoint)
    expect(upgraded.trace.metrics).toMatchObject({ maxRetries: state.friction.maxRetries })
    expect(upgraded.trace.metrics!.computedAt).toMatch(/^\d{4}-/)
  })

  it("records every file in a batch with one verification", () => {
    const state = createSessionState("s", temporary())
    const verification = createVerificationRecord({ command: "test", files: ["a.ts", "b.ts"], verdict: "pass", exitCode: 0, durationMs: 1, stdout: "", stderr: "" })
    const batch = addWriteBatch(state.trace, ["a.ts", "b.ts", "a.ts"], "MultiEdit", verification, 3)
    expect(state.trace.writes.map((write) => write.file)).toEqual(["a.ts", "b.ts"])
    expect(new Set(state.trace.writes.map((write) => write.batchId))).toEqual(new Set([batch]))
    expect(state.trace.verifications).toHaveLength(1)
  })
})

describe("detection", () => {
  it("detects a parent node project and package-manager verification", () => {
    const root = temporary()
    mkdirSync(join(root, "src", "nested"), { recursive: true })
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit" } }))
    writeFileSync(join(root, "pnpm-lock.yaml"), "")
    const project = detectProject(join(root, "src", "nested"))
    expect(project.type).toBe("node")
    expect(project.root).toBe(root)
    expect(getVerifyCommands(project)[0]).toMatchObject({ command: "pnpm", args: ["run", "typecheck"] })
  })
})

describe("validated Horizon persistence", () => {
  it("rejects mismatched sessions and malformed schemas", () => {
    const good = plan("a")
    expect(() => validateHorizonPlan({ ...good, sessionId: "b" }, "a")).toThrow(/different Horizon session/)
    expect(() => validateHorizonPlan({ ...good, stats: { ...good.stats, totalFeatures: 99 } })).toThrow(/stats/)
    expect(() => validateHorizonPlan({ ...good, milestones: [{ ...good.milestones[0], features: [{ ...good.milestones[0]!.features[0], status: "wat" }] }] })).toThrow(/status/)
  })

  it("keeps score-only compatibility advisory and non-ready", () => {
    const legacy = plan("legacy-passing")
    legacy.milestones[0]!.features[0]!.verification = { passed: true, score: 80, testResults: "legacy npm test passed", issues: [], featureDigest: null }
    const upgraded = validateHorizonPlan(legacy)
    expect(upgraded.milestones[0]!.features[0]!).toMatchObject({ status: "pending", evidence: { worker: { receipt: null }, auditor: { verdict: null } } })
  })

  it("keeps Horizon sessions isolated and emits YAML-safe skill metadata", () => {
    const root = temporary()
    const store = new HorizonStore(root)
    store.initSession("session-a", "A")
    store.initSession("session-b", "B")
    store.writePlan("session-a", plan("session-a"))
    const path = store.createSkill("session-a", "yaml-safe", "Uses: colon\nand a \"quote\"", "# Body")
    const skill = readFileSync(path, "utf8")
    expect(skill).toContain('description: "Uses: colon\\nand a \\"quote\\""')
    expect(store.listSkills("session-a")).toEqual(["yaml-safe"])
    expect(store.listSkills("session-b")).toEqual([])
    expect(store.readPlan("session-a")!.skills.sessionScoped).toEqual(["yaml-safe"])
    expect(store.readPlan("session-b")!.goal).toBe("B")
  })
})
