import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HorizonStore, validateHorizonPlan, type HorizonFaultStage, type HorizonStoreOptions, type HorizonTransitionOperation } from "../src/horizon.js"
import { VerificationLedger } from "../src/ledger.js"
import { createVerificationRecord } from "../src/trace.js"
import type { VerificationRecord } from "../src/types.js"
import { PARALLAX_SCHEMA_VERSION } from "../src/types.js"
import { horizonPlan, TestWorkspace } from "./fixtures.js"

const workspaces: TestWorkspace[] = []
function workspace(label: string): TestWorkspace { const item = new TestWorkspace(label); workspaces.push(item); return item }
afterEach(() => { while (workspaces.length) workspaces.pop()!.cleanup() })

function receipt(root: string, sessionId: string, verdict: "pass" | "fail" = "pass", startedAt?: string, durationMs = 1): VerificationRecord {
  return createVerificationRecord({
    sessionId, source: "manual", command: "node", args: ["--test"], cwd: root, timeoutMs: 100,
    durationMs, exitCode: verdict === "pass" ? 0 : 1, verdict, changedFiles: [], stdout: verdict, stderr: "", combined: verdict,
    outputTruncated: false, timedOut: false, skipReason: null,
  }, startedAt ? { startedAt } : undefined)
}

function initialized(maxAttempts = 3, options: HorizonStoreOptions = {}): { project: TestWorkspace; storeRoot: TestWorkspace; store: HorizonStore } {
  const project = workspace("kernel-project"); const storeRoot = workspace("kernel-store"); const store = new HorizonStore(storeRoot.root, options)
  store.initSession("parent", "Evidence gate"); store.writePlan("parent", horizonPlan("parent", { maxAttempts }))
  return { project, storeRoot, store }
}

describe("Horizon evidence kernel", () => {
  it("requires a bound pass receipt and a distinct accepting auditor", () => {
    const { project, store } = initialized()
    store.beginWorker("parent", "f1", "worker-1")
    expect(() => store.beginAuditor("parent", "f1", "auditor-1")).toThrow(/observed receipt/)
    const record = receipt(project.root, "worker-1"); new VerificationLedger(project.root).append(record)
    store.observeReceipt(project.root, "parent", "f1", record.id, "Worker summary")
    expect(() => store.beginAuditor("parent", "f1", "worker-1")).toThrow(/already been used/)
    store.beginAuditor("parent", "f1", "auditor-1")
    const completed = store.recordAudit("parent", "f1", "auditor-1", "accept", "Independent acceptance")
    expect(completed).toMatchObject({ status: "completed", stats: { completedFeatures: 1 }, milestones: [{ features: [{ status: "completed", attempts: 1 }] }] })
    expect(store.readActiveChild("parent")).toBeNull()
  })

  it("rejects non-pass acceptance and invalidates stale readiness for corrective work", () => {
    const { project, store } = initialized(2)
    store.beginWorker("parent", "f1", "worker-1")
    const failed = receipt(project.root, "worker-1", "fail"); new VerificationLedger(project.root).append(failed)
    store.observeReceipt(project.root, "parent", "f1", failed.id, "Tests failed")
    store.beginAuditor("parent", "f1", "auditor-1")
    expect(() => store.recordAudit("parent", "f1", "auditor-1", "accept", "Cannot accept")).toThrow(/non-pass/)
    store.recordAudit("parent", "f1", "auditor-1", "corrective-worker", "Correction required")
    store.beginWorker("parent", "f1", "worker-2")
    const feature = store.readPlan("parent")!.milestones[0]!.features[0]!
    expect(feature).toMatchObject({ status: "in_progress", attempts: 2, evidence: { worker: { childRunId: "worker-2", receipt: null }, auditor: { childRunId: null }, history: [{ worker: { receipt: { id: failed.id, verdict: "fail" } }, auditor: { verdict: "corrective-worker" } }] } })
  })

  it("rejects manufactured progress, inflated caps, reused receipts, mismatched ledgers, and oversized summaries", () => {
    const { project, store } = initialized()
    const forged = structuredClone(store.readPlan("parent")!)
    forged.milestones[0]!.features[0]!.attempts = 1
    expect(() => store.writePlan("parent", forged)).toThrow(/execution state/)
    const added = structuredClone(store.readPlan("parent")!); added.milestones[0]!.features.push({ ...structuredClone(added.milestones[0]!.features[0]!), id: "f2", maxAttempts: 99 })
    added.stats.totalFeatures = 2
    expect(() => store.writePlan("parent", added)).toThrow(/maxAttempts exceeds/)
    store.beginWorker("parent", "f1", "worker-1")
    const wrong = receipt(project.root, "other-worker"); new VerificationLedger(project.root).append(wrong)
    expect(() => store.observeReceipt(project.root, "parent", "f1", wrong.id, "Mismatch")).toThrow(/belongs to/)
    const right = receipt(project.root, "worker-1"); new VerificationLedger(project.root).append(right)
    expect(() => store.observeReceipt(project.root, "parent", "f1", right.id, "x".repeat(2001))).toThrow(/exceeds 2000/)
  })

  it("recovers an expired lease only with affirmative dead-child evidence", () => {
    const { storeRoot, store } = initialized()
    store.beginWorker("parent", "f1", "worker-1")
    const path = join(storeRoot.root, "sessions", "parent", "active-child.json")
    const lock = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; lock.leaseUntil = "2000-01-01T00:00:00.000Z"; writeFileSync(path, JSON.stringify(lock))
    expect(() => store.recoverActiveChild("parent", "f1", "worker-1")).toThrow(/liveness evidence/)
    expect(() => store.recoverActiveChild("parent", "f1", "worker-1", true)).toThrow(/still alive/)
    expect(store.recoverActiveChild("parent", "f1", "worker-1", false)).toBe(true)
    expect(store.readPlan("parent")!.milestones[0]!.features[0]!.status).toBe("pending")
    expect(store.recoverActiveChild("parent", "f1", "worker-1", false)).toBe(false)
  })

  it("enforces complete receipt chronology with an injectable clock while allowing equality", () => {
    const current = Date.parse("2026-07-21T12:00:00.000Z")
    const { project, store } = initialized(3, { now: () => current })
    store.beginWorker("parent", "f1", "worker-1")
    const workerStartedAt = store.readPlan("parent")!.milestones[0]!.features[0]!.evidence.worker.startedAt!
    const stale = receipt(project.root, "worker-1", "pass", new Date(Date.parse(workerStartedAt) - 1).toISOString())
    new VerificationLedger(project.root).append(stale)
    expect(() => store.observeReceipt(project.root, "parent", "f1", stale.id, "stale")).toThrow(/started before worker.*equality.*allowed/i)

    const future = receipt(project.root, "worker-1", "pass", new Date(current + 1_001).toISOString(), 0)
    new VerificationLedger(project.root).append(future)
    expect(() => store.observeReceipt(project.root, "parent", "f1", future.id, "future")).toThrow(/starts materially in the future/i)

    const impossibleEnd = receipt(project.root, "worker-1", "pass", workerStartedAt, 1_001)
    new VerificationLedger(project.root).append(impossibleEnd)
    expect(() => store.observeReceipt(project.root, "parent", "f1", impossibleEnd.id, "future end")).toThrow(/ends materially in the future.*impossible duration/i)

    const equal = receipt(project.root, "worker-1", "pass", workerStartedAt, 0)
    new VerificationLedger(project.root).append(equal)
    expect(store.observeReceipt(project.root, "parent", "f1", equal.id, "equal timestamp").milestones[0]!.features[0]!.evidence.worker.receipt?.id).toBe(equal.id)

    const malformed = structuredClone(store.readPlan("parent")!) as unknown as Record<string, unknown>
    const milestones = malformed.milestones as Array<Record<string, unknown>>
    const features = milestones[0]!.features as Array<Record<string, unknown>>
    const evidence = features[0]!.evidence as Record<string, unknown>
    const worker = evidence.worker as Record<string, unknown>; worker.startedAt = "not-a-date"
    expect(() => validateHorizonPlan(malformed, "parent")).toThrow(/parseable timestamp/)
  })

  it("fails closed when lock, state, and role-specific plan evidence do not agree", () => {
    const corrupt = (label: string, mutate: (root: string) => void, expected: RegExp): void => {
      const { storeRoot, store } = initialized()
      store.beginWorker("parent", "f1", `worker-${label}`)
      const session = join(storeRoot.root, "sessions", "parent")
      const lockPath = join(session, "active-child.json")
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>
      lock.leaseUntil = "2000-01-01T00:00:00.000Z"; writeFileSync(lockPath, JSON.stringify(lock))
      mutate(session)
      expect(() => store.recoverActiveChild("parent", "f1", `worker-${label}`, false)).toThrow(expected)
      if (existsSync(lockPath)) expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ childRunId: `worker-${label}` })
    }

    corrupt("state", (session) => {
      const path = join(session, "state.json"); const state = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      state.activeSubAgents = []; writeFileSync(path, JSON.stringify(state))
    }, /recovery corruption: state does not match/i)
    corrupt("role", (session) => {
      const path = join(session, "active-child.json"); const lock = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
      lock.role = "auditor"; writeFileSync(path, JSON.stringify(lock))
    }, /recovery corruption: plan evidence does not match auditor/i)
    corrupt("missing-state", (session) => rmSync(join(session, "state.json")), /recovery corruption: Horizon state not found/i)
    corrupt("missing-lock", (session) => rmSync(join(session, "active-child.json")), /active state or plan evidence exists without a lock/i)
  })

  it("recovers every journaled transition stage to the fully committed target", () => {
    const acquiring: HorizonFaultStage[] = ["journal-written", "active-child-written", "plan-written", "state-written", "index-written", "journal-cleared"]
    const releasing: HorizonFaultStage[] = ["journal-written", "plan-written", "state-written", "index-written", "active-child-released", "journal-cleared"]

    const exercise = (operation: HorizonTransitionOperation, stage: HorizonFaultStage): void => {
      const project = workspace(`fault-project-${operation}-${stage}`)
      const storeRoot = workspace(`fault-store-${operation}-${stage}`)
      const setup = new HorizonStore(storeRoot.root)
      setup.initSession("parent", "Fault recovery"); setup.writePlan("parent", horizonPlan("parent"))
      if (operation !== "begin-worker") setup.beginWorker("parent", "f1", "worker-1")
      if (operation === "observe-receipt" || operation === "begin-auditor" || operation === "record-audit") {
        const startedAt = setup.readPlan("parent")!.milestones[0]!.features[0]!.evidence.worker.startedAt!
        const record = receipt(project.root, "worker-1", "pass", startedAt); new VerificationLedger(project.root).append(record)
        if (operation !== "observe-receipt") setup.observeReceipt(project.root, "parent", "f1", record.id, "worker done")
      }
      if (operation === "record-audit") setup.beginAuditor("parent", "f1", "auditor-1")

      const crashing = new HorizonStore(storeRoot.root, { faultInjector: (seen, seenOperation) => { if (seen === stage && seenOperation === operation) throw new Error(`fault:${stage}`) } })
      const invoke = (): void => {
        if (operation === "begin-worker") { crashing.beginWorker("parent", "f1", "worker-1"); return }
        if (operation === "observe-receipt") {
          const record = new VerificationLedger(project.root).read().at(-1)!
          crashing.observeReceipt(project.root, "parent", "f1", record.id, "worker done"); return
        }
        if (operation === "begin-auditor") { crashing.beginAuditor("parent", "f1", "auditor-1"); return }
        crashing.recordAudit("parent", "f1", "auditor-1", "accept", "accepted")
      }
      expect(invoke).toThrow(`fault:${stage}`)
      const recovered = new HorizonStore(storeRoot.root)
      const feature = recovered.readPlan("parent")!.milestones[0]!.features[0]!
      const state = recovered.readState("parent")!
      const lock = recovered.readActiveChild("parent")
      if (operation === "begin-worker") { expect(feature.evidence.worker.childRunId).toBe("worker-1"); expect(lock?.childRunId).toBe("worker-1") }
      if (operation === "observe-receipt") { expect(feature.evidence.worker.receipt).not.toBeNull(); expect(lock).toBeNull() }
      if (operation === "begin-auditor") { expect(feature.evidence.auditor.childRunId).toBe("auditor-1"); expect(lock?.childRunId).toBe("auditor-1") }
      if (operation === "record-audit") { expect(feature.status).toBe("completed"); expect(lock).toBeNull() }
      expect(state.activeSubAgents).toEqual(lock ? [lock.childRunId] : [])
      expect(() => readFileSync(join(storeRoot.root, "sessions", "parent", "transition.json"), "utf8")).toThrow()
    }

    for (const operation of ["begin-worker", "begin-auditor"] as const) for (const stage of acquiring) exercise(operation, stage)
    for (const operation of ["observe-receipt", "record-audit"] as const) for (const stage of releasing) exercise(operation, stage)
  })

  it("recovers an interrupted active-child recovery at every artifact boundary", () => {
    const stages: HorizonFaultStage[] = ["journal-written", "plan-written", "state-written", "index-written", "active-child-released", "journal-cleared"]
    for (const stage of stages) {
      const storeRoot = workspace(`recover-fault-${stage}`)
      const setup = new HorizonStore(storeRoot.root)
      setup.initSession("parent", "Recovery fault"); setup.writePlan("parent", horizonPlan("parent")); setup.beginWorker("parent", "f1", "worker-1")
      const lockPath = join(storeRoot.root, "sessions", "parent", "active-child.json")
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>; lock.leaseUntil = "2000-01-01T00:00:00.000Z"; writeFileSync(lockPath, JSON.stringify(lock))
      const crashing = new HorizonStore(storeRoot.root, { faultInjector: (seen, operation) => { if (operation === "recover-active-child" && seen === stage) throw new Error(`fault:${stage}`) } })
      expect(() => crashing.recoverActiveChild("parent", "f1", "worker-1", false)).toThrow(`fault:${stage}`)

      // Any subsequent store access completes a still-journaled recovery.
      const state = crashing.readState("parent")!
      const plan = crashing.readPlan("parent")!
      const index = JSON.parse(readFileSync(join(storeRoot.root, "index.json"), "utf8")) as { sessions: Record<string, { status: string }> }
      expect(plan.milestones[0]!.features[0]!).toMatchObject({ status: "pending", subAgentSessionId: null, evidence: { worker: { childRunId: null } } })
      expect(state).toMatchObject({ activeSubAgents: [], currentFeatureId: "f1" })
      expect(crashing.readActiveChild("parent")).toBeNull()
      expect(index.sessions.parent?.status).toBe(plan.status)
      expect(existsSync(join(storeRoot.root, "sessions", "parent", "transition.json"))).toBe(false)
      expect(crashing.recoverActiveChild("parent", "f1", "worker-1", false)).toBe(false)
    }
  })

  it("migrates legacy score-only completion to explicit non-ready evidence", () => {
    const root = workspace("legacy-evidence"); const session = join(root.root, "sessions", "legacy"); mkdirSync(session, { recursive: true })
    const legacy = horizonPlan("legacy", { status: "completed", attempts: 1, verification: { passed: true, score: 100, testResults: "old score", issues: [], featureDigest: null } }) as unknown as Record<string, unknown>
    const milestones = legacy.milestones as Array<Record<string, unknown>>; milestones[0]!.status = "completed"
    const features = milestones[0]!.features as Array<Record<string, unknown>>; delete features[0]!.evidence
    legacy.status = "completed"; legacy.completedAt = "2026-01-02T03:04:05.000Z"; legacy.stats = { totalFeatures: 1, completedFeatures: 1, failedFeatures: 0, totalRetries: 1, estimatedCost: null }
    writeFileSync(join(session, "plan.json"), JSON.stringify(legacy)); writeFileSync(join(session, "state.json"), JSON.stringify({ schemaVersion: PARALLAX_SCHEMA_VERSION, sessionId: "legacy", currentPhase: "complete", activeSubAgents: [], currentMilestoneId: null, currentFeatureId: null, lastCheckpoint: "2026-01-02T03:04:05.000Z", pausedAt: null, pauseReason: null })); writeFileSync(join(session, "decisions.jsonl"), "")
    writeFileSync(join(root.root, "index.json"), JSON.stringify({ schemaVersion: PARALLAX_SCHEMA_VERSION, sessions: { legacy: { goal: legacy.goal, createdAt: legacy.createdAt, updatedAt: legacy.createdAt, status: "completed", autonomyLevel: "full" } } }))
    const migrated = new HorizonStore(root.root).readPlan("legacy")!
    expect(migrated).toMatchObject({ status: "planning", completedAt: null, milestones: [{ features: [{ status: "pending", verification: { passed: false }, evidence: { worker: { childRunId: null }, auditor: { childRunId: null } } }] }] })
  })
})
