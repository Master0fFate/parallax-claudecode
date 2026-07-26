import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { withDirectoryLock } from "./lock.js"
import { atomicWriteJson, atomicWriteText } from "./state.js"
import { VerificationLedger } from "./ledger.js"
import {
  PARALLAX_SCHEMA_VERSION,
  type HorizonAutonomyLevel,
  type HorizonActiveChildLock,
  type HorizonAuditVerdict,
  type HorizonConfig,
  type HorizonDecision,
  type HorizonFeature,
  type HorizonIndex,
  type HorizonItemStatus,
  type HorizonMilestone,
  type HorizonPlan,
  type HorizonState,
  type VerificationRecord,
} from "./types.js"

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ITEM_STATUSES = new Set(["pending", "in_progress", "completed", "failed"])
const PLAN_STATUSES = new Set(["planning", "executing", "completed", "failed"])
const AUTONOMY = new Set(["full", "semi", "supervised"])
const PHASES = new Set(["research", "plan", "execute", "audit", "complete"])
const CONFIDENCE = new Set(["high", "medium", "low"])
const RECEIPT_VERDICTS = new Set(["pass", "fail", "skipped", "unknown"])
const AUDIT_VERDICTS = new Set(["accept", "corrective-worker"])
const SUMMARY_LIMIT = 2_000
const CHILD_LEASE_MS = 30 * 60 * 1_000
// Receipt production and observation may cross process clocks. One second permits
// scheduler/clock granularity without accepting materially future evidence.
const RECEIPT_CLOCK_SKEW_MS = 1_000

export type HorizonTransitionOperation = "begin-worker" | "observe-receipt" | "begin-auditor" | "record-audit" | "recover-active-child" | "abort-active-child"
export type HorizonFaultStage = "journal-written" | "active-child-written" | "plan-written" | "state-written" | "index-written" | "active-child-released" | "journal-cleared"
export interface HorizonStoreOptions {
  faultInjector?: (stage: HorizonFaultStage, operation: HorizonTransitionOperation) => void
  now?: () => number
}

interface HorizonTransitionJournal {
  schemaVersion: 1
  root: string
  sessionId: string
  operation: HorizonTransitionOperation
  createdAt: string
  target: { plan: HorizonPlan; state: HorizonState; activeChild: HorizonActiveChildLock | null; index: HorizonIndex }
}

export const DEFAULT_HORIZON_CONFIG: HorizonConfig = {
  autonomyLevel: "full",
  autoApproveMilestones: true,
  maxRetryCycles: 3,
  decisionConfidenceThreshold: 0.7,
  pauseOnCriticalFailure: true,
  testCommand: "npm test",
  lintCommand: "npm run lint",
}

function now(): string { return new Date().toISOString() }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)) }
function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${label} must be a non-empty string`)
  return value
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${label} must be a string array`)
  return value
}
function integer(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum) throw new Error(`${label} must be an integer >= ${minimum}`)
  return value
}
function nullableString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") throw new Error(`${label} must be a string or null`)
  return value
}
function timestampString(value: unknown, label: string): string {
  const result = string(value, label)
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${label} must be a parseable timestamp`)
  return result
}
function nullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : timestampString(value, label)
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) throw new Error(`${label} contains unknown fields: ${unknown.join(", ")}`)
}
function boundedSummary(value: unknown, label: string): string | null {
  const result = nullableString(value, label)
  if (result !== null && result.length > SUMMARY_LIMIT) throw new Error(`${label} exceeds ${SUMMARY_LIMIT} characters`)
  return result
}
function nullableSafeId(value: unknown, label: string): string | null {
  const result = nullableString(value, label)
  return result === null ? null : assertSafeId(label, result)
}
function emptyEvidence(): HorizonFeature["evidence"] {
  return {
    worker: { childRunId: null, startedAt: null, completedAt: null, receipt: null, summary: null, traceId: null },
    auditor: { childRunId: null, startedAt: null, completedAt: null, verdict: null, summary: null, traceId: null },
    history: [],
  }
}

function validateEvidence(value: unknown, label: string): HorizonFeature["evidence"] {
  if (!object(value) || !object(value.worker) || !object(value.auditor)) throw new Error(`${label}.evidence is invalid`)
  exactKeys(value, ["worker", "auditor", "history"], `${label}.evidence`)
  exactKeys(value.worker, ["childRunId", "startedAt", "completedAt", "receipt", "summary", "traceId"], `${label}.evidence.worker`)
  exactKeys(value.auditor, ["childRunId", "startedAt", "completedAt", "verdict", "summary", "traceId"], `${label}.evidence.auditor`)
  let receipt: HorizonFeature["evidence"]["worker"]["receipt"] = null
  if (value.worker.receipt !== null) {
    if (!object(value.worker.receipt)) throw new Error(`${label}.evidence.worker.receipt is invalid`)
    exactKeys(value.worker.receipt, ["id", "verdict", "sessionId", "source", "cwd", "startedAt", "observedAt"], `${label}.evidence.worker.receipt`)
    const verdict = string(value.worker.receipt.verdict, `${label}.receipt.verdict`) as VerificationRecord["verdict"]
    if (!RECEIPT_VERDICTS.has(verdict)) throw new Error(`${label}.receipt.verdict is invalid`)
    const source = string(value.worker.receipt.source, `${label}.receipt.source`) as VerificationRecord["source"]
    if (source !== "manual" && source !== "automatic") throw new Error(`${label}.receipt.source is invalid`)
    receipt = {
      id: assertSafeId("receipt ID", string(value.worker.receipt.id, `${label}.receipt.id`)), verdict,
      sessionId: assertSafeId("receipt session ID", string(value.worker.receipt.sessionId, `${label}.receipt.sessionId`)), source,
      cwd: string(value.worker.receipt.cwd, `${label}.receipt.cwd`), startedAt: timestampString(value.worker.receipt.startedAt, `${label}.receipt.startedAt`),
      observedAt: timestampString(value.worker.receipt.observedAt, `${label}.receipt.observedAt`),
    }
  }
  const auditVerdict = value.auditor.verdict === null ? null : string(value.auditor.verdict, `${label}.auditor.verdict`) as HorizonAuditVerdict
  if (auditVerdict !== null && !AUDIT_VERDICTS.has(auditVerdict)) throw new Error(`${label}.auditor.verdict is invalid`)
  return {
    worker: {
      childRunId: nullableSafeId(value.worker.childRunId, `${label}.worker.childRunId`), startedAt: nullableTimestamp(value.worker.startedAt, `${label}.worker.startedAt`),
      completedAt: nullableTimestamp(value.worker.completedAt, `${label}.worker.completedAt`), receipt,
      summary: boundedSummary(value.worker.summary, `${label}.worker.summary`), traceId: nullableSafeId(value.worker.traceId, `${label}.worker.traceId`),
    },
    auditor: {
      childRunId: nullableSafeId(value.auditor.childRunId, `${label}.auditor.childRunId`), startedAt: nullableTimestamp(value.auditor.startedAt, `${label}.auditor.startedAt`),
      completedAt: nullableTimestamp(value.auditor.completedAt, `${label}.auditor.completedAt`), verdict: auditVerdict,
      summary: boundedSummary(value.auditor.summary, `${label}.auditor.summary`), traceId: nullableSafeId(value.auditor.traceId, `${label}.auditor.traceId`),
    },
    history: (value.history === undefined ? [] : Array.isArray(value.history) ? value.history : (() => { throw new Error(`${label}.evidence.history must be an array`) })())
      .map((attempt, index) => {
        if (!object(attempt)) throw new Error(`${label}.evidence.history[${index}] is invalid`)
        exactKeys(attempt, ["worker", "auditor"], `${label}.evidence.history[${index}]`)
        const parsed = validateEvidence({ worker: attempt.worker, auditor: attempt.auditor, history: [] }, `${label}.history[${index}]`)
        if (!parsed.worker.receipt || !parsed.worker.completedAt || !parsed.auditor.verdict || !parsed.auditor.completedAt) throw new Error(`${label}.evidence.history[${index}] must be a completed attempt`)
        return { worker: parsed.worker, auditor: parsed.auditor }
      }),
  }
}

export function assertSafeId(kind: string, value: string): string {
  if (!SAFE_ID.test(value) || value === "." || value === ".." || basename(value) !== value) throw new Error(`Invalid ${kind}: ${value}`)
  return value
}

function validateVerification(value: unknown, label: string): HorizonFeature["verification"] {
  if (!object(value) || typeof value.passed !== "boolean") throw new Error(`${label} verification is invalid`)
  exactKeys(value, ["passed", "testResults", "issues", "score", "featureDigest"], `${label}.verification`)
  const score = value.score
  if (score !== null && (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100)) throw new Error(`${label} verification score is invalid`)
  const featureDigest = value.featureDigest === undefined ? null : nullableString(value.featureDigest, `${label}.featureDigest`)
  if (featureDigest !== null && !/^[a-f0-9]{64}$/.test(featureDigest)) throw new Error(`${label} verification featureDigest is invalid`)
  return {
    passed: value.passed,
    testResults: nullableString(value.testResults, `${label}.testResults`),
    issues: strings(value.issues, `${label}.issues`),
    score,
    featureDigest,
  }
}

function validateFeature(value: unknown, label: string): HorizonFeature {
  if (!object(value)) throw new Error(`${label} must be an object`)
  exactKeys(value, ["id", "name", "description", "acceptanceCriteria", "protocolLevel", "status", "order", "subAgentSessionId", "attempts", "maxAttempts", "verification", "evidence", "skillsRequired", "skillsGenerated"], label)
  const id = assertSafeId("feature ID", string(value.id, `${label}.id`))
  const status = string(value.status, `${label}.status`) as HorizonItemStatus
  if (!ITEM_STATUSES.has(status)) throw new Error(`${label}.status is invalid`)
  const protocolLevel = string(value.protocolLevel, `${label}.protocolLevel`)
  if (protocolLevel !== "none" && protocolLevel !== "full") throw new Error(`${label}.protocolLevel is invalid`)
  const attempts = integer(value.attempts, `${label}.attempts`)
  const maxAttempts = integer(value.maxAttempts, `${label}.maxAttempts`, 1)
  if (attempts > maxAttempts) throw new Error(`${label}.attempts exceeds maxAttempts`)
  const feature: HorizonFeature = {
    id,
    name: string(value.name, `${label}.name`),
    description: string(value.description, `${label}.description`, true),
    acceptanceCriteria: string(value.acceptanceCriteria, `${label}.acceptanceCriteria`),
    protocolLevel,
    status,
    order: integer(value.order, `${label}.order`, 1),
    subAgentSessionId: nullableString(value.subAgentSessionId, `${label}.subAgentSessionId`),
    attempts,
    maxAttempts,
    verification: validateVerification(value.verification, label),
    evidence: value.evidence === undefined ? emptyEvidence() : validateEvidence(value.evidence, label),
    skillsRequired: strings(value.skillsRequired, `${label}.skillsRequired`),
    skillsGenerated: strings(value.skillsGenerated, `${label}.skillsGenerated`),
  }
  const worker = feature.evidence.worker
  const auditor = feature.evidence.auditor
  if ((worker.childRunId === null) !== (worker.startedAt === null)) throw new Error(`${label} worker identity and start time must be set together`)
  if (worker.receipt && (!worker.childRunId || worker.receipt.sessionId !== worker.childRunId || !worker.completedAt || worker.summary === null)) throw new Error(`${label} worker receipt is not bound to completed worker evidence`)
  if (!worker.receipt && (worker.completedAt !== null || worker.summary !== null || worker.traceId !== null)) throw new Error(`${label} incomplete worker cannot retain completion evidence`)
  if ((auditor.childRunId === null) !== (auditor.startedAt === null)) throw new Error(`${label} auditor identity and start time must be set together`)
  if (auditor.childRunId && !worker.receipt) throw new Error(`${label} auditor requires an observed worker receipt`)
  if (auditor.verdict !== null && (!auditor.childRunId || !auditor.completedAt || auditor.summary === null)) throw new Error(`${label} audit verdict requires completed auditor evidence`)
  if (auditor.verdict === null && (auditor.completedAt !== null || auditor.summary !== null || auditor.traceId !== null)) throw new Error(`${label} incomplete auditor cannot retain completion evidence`)
  if (worker.childRunId && auditor.childRunId === worker.childRunId) throw new Error(`${label} worker cannot audit its own work`)
  if (auditor.verdict === "accept" && worker.receipt?.verdict !== "pass") throw new Error(`${label} non-pass receipt cannot be accepted`)
  if (feature.status === "completed" && (worker.receipt?.verdict !== "pass" || auditor.verdict !== "accept")) throw new Error(`Completed feature ${feature.id} requires pass receipt and independent acceptance`)
  return feature
}

function validateMilestone(value: unknown, index: number): HorizonMilestone {
  const label = `milestones[${index}]`
  if (!object(value) || !Array.isArray(value.features)) throw new Error(`${label} is invalid`)
  exactKeys(value, ["id", "name", "description", "status", "order", "requiresApproval", "features"], label)
  const status = string(value.status, `${label}.status`) as HorizonItemStatus
  if (!ITEM_STATUSES.has(status)) throw new Error(`${label}.status is invalid`)
  if (typeof value.requiresApproval !== "boolean") throw new Error(`${label}.requiresApproval must be boolean`)
  return {
    id: assertSafeId("milestone ID", string(value.id, `${label}.id`)),
    name: string(value.name, `${label}.name`),
    description: string(value.description, `${label}.description`, true),
    status,
    order: integer(value.order, `${label}.order`, 1),
    requiresApproval: value.requiresApproval,
    features: value.features.map((feature, featureIndex) => validateFeature(feature, `${label}.features[${featureIndex}]`)),
  }
}

export function featureVerificationDigest(goal: string, feature: HorizonFeature): string {
  return createHash("sha256").update(JSON.stringify({
    goal,
    id: feature.id,
    name: feature.name,
    description: feature.description,
    acceptanceCriteria: feature.acceptanceCriteria,
    protocolLevel: feature.protocolLevel,
    order: feature.order,
    maxAttempts: feature.maxAttempts,
    skillsRequired: feature.skillsRequired,
    skillsGenerated: feature.skillsGenerated,
  })).digest("hex")
}

export function validateHorizonPlan(value: unknown, expectedSessionId?: string): HorizonPlan {
  if (!object(value) || value.schemaVersion !== PARALLAX_SCHEMA_VERSION || !Array.isArray(value.milestones)) throw new Error("Invalid Horizon plan schema")
  exactKeys(value, ["schemaVersion", "sessionId", "goal", "autonomyLevel", "status", "createdAt", "completedAt", "milestones", "skills", "stats"], "plan")
  const sessionId = assertSafeId("session ID", string(value.sessionId, "plan.sessionId"))
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) throw new Error("Plan belongs to a different Horizon session")
  const autonomyLevel = string(value.autonomyLevel, "plan.autonomyLevel") as HorizonAutonomyLevel
  if (!AUTONOMY.has(autonomyLevel)) throw new Error("Invalid plan autonomyLevel")
  const status = string(value.status, "plan.status") as HorizonPlan["status"]
  if (!PLAN_STATUSES.has(status)) throw new Error("Invalid plan status")
  const milestones = value.milestones.map(validateMilestone)
  const milestoneIds = milestones.map((item) => item.id)
  const featureIds = milestones.flatMap((item) => item.features.map((feature) => feature.id))
  if (new Set(milestoneIds).size !== milestoneIds.length) throw new Error("Milestone IDs must be unique")
  if (new Set(featureIds).size !== featureIds.length) throw new Error("Feature IDs must be unique across the plan")
  if (!object(value.skills) || !object(value.stats)) throw new Error("Invalid plan skills or stats")
  exactKeys(value.skills, ["global", "sessionScoped"], "plan.skills")
  exactKeys(value.stats, ["totalFeatures", "completedFeatures", "failedFeatures", "totalRetries", "estimatedCost"], "plan.stats")
  const completedAt = nullableString(value.completedAt, "plan.completedAt")
  const estimatedCost = value.stats.estimatedCost
  if (estimatedCost !== null && (typeof estimatedCost !== "number" || !Number.isFinite(estimatedCost) || estimatedCost < 0)) throw new Error("Invalid estimatedCost")
  const plan: HorizonPlan = {
    schemaVersion: PARALLAX_SCHEMA_VERSION,
    sessionId,
    goal: string(value.goal, "plan.goal"),
    autonomyLevel,
    status,
    createdAt: string(value.createdAt, "plan.createdAt"),
    completedAt,
    milestones,
    skills: { global: strings(value.skills.global, "plan.skills.global"), sessionScoped: strings(value.skills.sessionScoped, "plan.skills.sessionScoped") },
    stats: {
      totalFeatures: integer(value.stats.totalFeatures, "plan.stats.totalFeatures"),
      completedFeatures: integer(value.stats.completedFeatures, "plan.stats.completedFeatures"),
      failedFeatures: integer(value.stats.failedFeatures, "plan.stats.failedFeatures"),
      totalRetries: integer(value.stats.totalRetries, "plan.stats.totalRetries"),
      estimatedCost,
    },
  }
  for (const milestone of plan.milestones) {
    for (const feature of milestone.features) {
      if (feature.verification.featureDigest !== null && feature.verification.featureDigest !== featureVerificationDigest(plan.goal, feature)) throw new Error(`Feature ${feature.id} advisory evaluation does not match its current definition`)
    }
    if (milestone.status === "completed" && (milestone.features.length === 0 || milestone.features.some((feature) => feature.status !== "completed"))) {
      throw new Error(`Completed milestone ${milestone.id} must contain only completed features`)
    }
    if (milestone.status === "failed" && !milestone.features.some((feature) => feature.status === "failed")) throw new Error(`Failed milestone ${milestone.id} requires a failed feature`)
  }
  if (status === "completed") {
    if (milestones.length === 0 || milestones.some((milestone) => milestone.status !== "completed")) throw new Error("Completed plan must contain only completed milestones")
    if (completedAt === null) throw new Error("Completed plan requires completedAt")
  } else if (completedAt !== null) throw new Error("Only a completed plan may set completedAt")
  if (status === "failed" && !milestones.some((milestone) => milestone.status === "failed")) throw new Error("Failed plan requires a failed milestone")
  const expected = computePlanStats(plan)
  if (plan.stats.totalFeatures !== expected.totalFeatures || plan.stats.completedFeatures !== expected.completedFeatures || plan.stats.failedFeatures !== expected.failedFeatures || plan.stats.totalRetries !== expected.totalRetries) {
    throw new Error("Plan stats do not match feature data")
  }
  const active = milestones.flatMap((milestone) => milestone.features).filter((feature) => feature.status === "in_progress")
  if (active.length > 1) throw new Error("Only one Horizon feature may be active")
  return plan
}

export function validateHorizonState(value: unknown, expectedSessionId?: string): HorizonState {
  if (!object(value) || value.schemaVersion !== PARALLAX_SCHEMA_VERSION) throw new Error("Invalid Horizon state schema")
  exactKeys(value, ["schemaVersion", "sessionId", "currentPhase", "activeSubAgents", "currentMilestoneId", "currentFeatureId", "lastCheckpoint", "pausedAt", "pauseReason"], "state")
  const sessionId = assertSafeId("session ID", string(value.sessionId, "state.sessionId"))
  if (expectedSessionId !== undefined && sessionId !== expectedSessionId) throw new Error("State belongs to a different Horizon session")
  const currentPhase = string(value.currentPhase, "state.currentPhase") as HorizonState["currentPhase"]
  if (!PHASES.has(currentPhase)) throw new Error("Invalid Horizon phase")
  return {
    schemaVersion: PARALLAX_SCHEMA_VERSION,
    sessionId,
    currentPhase,
    activeSubAgents: strings(value.activeSubAgents, "state.activeSubAgents"),
    currentMilestoneId: nullableString(value.currentMilestoneId, "state.currentMilestoneId"),
    currentFeatureId: nullableString(value.currentFeatureId, "state.currentFeatureId"),
    lastCheckpoint: string(value.lastCheckpoint, "state.lastCheckpoint"),
    pausedAt: nullableString(value.pausedAt, "state.pausedAt"),
    pauseReason: nullableString(value.pauseReason, "state.pauseReason"),
  }
}

export function validateHorizonStateAgainstPlan(state: HorizonState, plan: HorizonPlan): void {
  const milestone = state.currentMilestoneId === null ? null : plan.milestones.find((item) => item.id === state.currentMilestoneId)
  if (state.currentMilestoneId !== null && !milestone) throw new Error(`State references unknown milestone ${state.currentMilestoneId}`)
  const featureMilestone = state.currentFeatureId === null ? null : plan.milestones.find((item) => item.features.some((feature) => feature.id === state.currentFeatureId))
  if (state.currentFeatureId !== null && !featureMilestone) throw new Error(`State references unknown feature ${state.currentFeatureId}`)
  if (milestone && featureMilestone && milestone.id !== featureMilestone.id) throw new Error("State current feature does not belong to its current milestone")
  if ((state.currentPhase === "complete") !== (plan.status === "completed")) throw new Error("Horizon state and plan completion phases do not match")
}

export function validateHorizonDecision(value: unknown): HorizonDecision {
  if (!object(value)) throw new Error("Decision must be an object")
  exactKeys(value, ["timestamp", "feature", "ambiguity", "researchResult", "decision", "rationale", "confidence"], "decision")
  const confidence = string(value.confidence, "decision.confidence") as HorizonDecision["confidence"]
  if (!CONFIDENCE.has(confidence)) throw new Error("Invalid decision confidence")
  return {
    timestamp: string(value.timestamp, "decision.timestamp"),
    feature: string(value.feature, "decision.feature", true),
    ambiguity: string(value.ambiguity, "decision.ambiguity"),
    researchResult: string(value.researchResult, "decision.researchResult", true),
    decision: string(value.decision, "decision.decision"),
    rationale: string(value.rationale, "decision.rationale"),
    confidence,
  }
}

export function validateHorizonConfig(value: unknown): HorizonConfig {
  if (!object(value)) throw new Error("Horizon config must be an object")
  exactKeys(value, ["autonomyLevel", "autoApproveMilestones", "maxRetryCycles", "decisionConfidenceThreshold", "pauseOnCriticalFailure", "testCommand", "lintCommand"], "config")
  const autonomyLevel = string(value.autonomyLevel, "config.autonomyLevel") as HorizonAutonomyLevel
  if (!AUTONOMY.has(autonomyLevel)) throw new Error("Invalid config autonomyLevel")
  const threshold = value.decisionConfidenceThreshold
  if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Invalid decisionConfidenceThreshold")
  if (typeof value.autoApproveMilestones !== "boolean" || typeof value.pauseOnCriticalFailure !== "boolean") throw new Error("Invalid Horizon config flags")
  return {
    autonomyLevel,
    autoApproveMilestones: value.autoApproveMilestones,
    maxRetryCycles: integer(value.maxRetryCycles, "config.maxRetryCycles", 1),
    decisionConfidenceThreshold: threshold,
    pauseOnCriticalFailure: value.pauseOnCriticalFailure,
    testCommand: string(value.testCommand, "config.testCommand"),
    lintCommand: string(value.lintCommand, "config.lintCommand"),
  }
}

export function validateHorizonIndex(value: unknown): HorizonIndex {
  if (!object(value) || value.schemaVersion !== PARALLAX_SCHEMA_VERSION || !object(value.sessions)) throw new Error("Invalid Horizon index schema")
  const sessions: HorizonIndex["sessions"] = {}
  for (const [id, metadata] of Object.entries(value.sessions)) {
    assertSafeId("session ID", id)
    if (!object(metadata)) throw new Error(`Invalid index entry: ${id}`)
    exactKeys(metadata, ["goal", "createdAt", "updatedAt", "status", "autonomyLevel"], `index.${id}`)
    const status = string(metadata.status, `index.${id}.status`) as HorizonPlan["status"]
    const autonomyLevel = string(metadata.autonomyLevel, `index.${id}.autonomyLevel`) as HorizonAutonomyLevel
    if (!PLAN_STATUSES.has(status) || !AUTONOMY.has(autonomyLevel)) throw new Error(`Invalid index entry: ${id}`)
    sessions[id] = {
      goal: string(metadata.goal, `index.${id}.goal`), createdAt: string(metadata.createdAt, `index.${id}.createdAt`),
      updatedAt: string(metadata.updatedAt, `index.${id}.updatedAt`), status, autonomyLevel,
    }
  }
  return { schemaVersion: PARALLAX_SCHEMA_VERSION, sessions }
}

function computePlanStats(plan: HorizonPlan): HorizonPlan["stats"] {
  const features = plan.milestones.flatMap((milestone) => milestone.features)
  return {
    totalFeatures: features.length,
    completedFeatures: features.filter((feature) => feature.status === "completed").length,
    failedFeatures: features.filter((feature) => feature.status === "failed").length,
    totalRetries: features.reduce((sum, feature) => sum + feature.attempts, 0),
    estimatedCost: plan.stats.estimatedCost,
  }
}

function readJson(path: string): unknown | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as unknown }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error(`Invalid JSON at ${path}: ${String(error)}`)
  }
}

export function validateHorizonActiveChild(value: unknown, root: string, sessionId: string): HorizonActiveChildLock {
  if (!object(value)) throw new Error("Invalid Horizon active-child lock")
  exactKeys(value, ["schemaVersion", "root", "sessionId", "featureId", "role", "childRunId", "acquiredAt", "leaseUntil"], "active-child lock")
  if (value.schemaVersion !== 1 || value.root !== root || value.sessionId !== sessionId || (value.role !== "worker" && value.role !== "auditor")) throw new Error("Invalid Horizon active-child lock identity")
  const acquiredAt = timestampString(value.acquiredAt, "lock.acquiredAt")
  const leaseUntil = timestampString(value.leaseUntil, "lock.leaseUntil")
  return {
    schemaVersion: 1, root, sessionId: assertSafeId("session ID", sessionId),
    featureId: assertSafeId("feature ID", string(value.featureId, "lock.featureId")), role: value.role,
    childRunId: assertSafeId("child run ID", string(value.childRunId, "lock.childRunId")), acquiredAt, leaseUntil,
  }
}

export class HorizonStore {
  readonly root: string
  private lockDepth = 0
  private readonly faultInjector: HorizonStoreOptions["faultInjector"]
  private readonly clock: () => number
  constructor(root = process.env.PARALLAX_HORIZON_HOME || join(homedir(), ".parallax", "horizon"), options: HorizonStoreOptions = {}) {
    this.root = resolve(root)
    this.faultInjector = options.faultInjector
    this.clock = options.now ?? Date.now
    this.withLock(() => { this.recoverAllTransactions(); this.migrateLegacyStore(); this.migrateEvidenceStore() })
  }

  private currentTime(): number { return this.clock() }
  private currentTimestamp(): string { return new Date(this.currentTime()).toISOString() }

  private withLock<T>(operation: () => T): T {
    if (this.lockDepth > 0) return operation()
    const lock = join(this.root, ".locks", "store.lock")
    return withDirectoryLock(lock, () => {
      this.lockDepth += 1
      try { return operation() }
      finally { this.lockDepth -= 1 }
    }, { timeoutMs: 10_000, label: "Horizon store" })
  }

  /** Backup and fully validate the complete OpenCode-era store before committing migration. */
  private migrateLegacyStore(): void {
    const indexPath = join(this.root, "index.json")
    const rawIndex = readJson(indexPath)
    if (!object(rawIndex) || rawIndex.schemaVersion === PARALLAX_SCHEMA_VERSION || !object(rawIndex.sessions)) return
    const stamp = `${now().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
    const backup = join(dirname(this.root), `horizon-opencode-backup-${stamp}`)
    cpSync(this.root, backup, { recursive: true, errorOnExist: true })
    // This lock belongs to migration, not to the legacy data being preserved.
    rmSync(join(backup, ".locks"), { recursive: true, force: true })

    try {
      const updatedAt = now()
      const plans = new Map<string, HorizonPlan>()
      const states = new Map<string, HorizonState>()
      const indexedIds = Object.keys(rawIndex.sessions).sort()
      for (const id of indexedIds) {
        assertSafeId("session ID", id)
        const rawMeta = rawIndex.sessions[id]
        if (!object(rawMeta)) throw new Error(`Cannot migrate invalid legacy index entry: ${id}`)
        const legacyStatus = string(rawMeta.status, `legacy index.${id}.status`) as HorizonPlan["status"]
        const legacyAutonomy = string(rawMeta.autonomyLevel, `legacy index.${id}.autonomyLevel`) as HorizonAutonomyLevel
        if (!PLAN_STATUSES.has(legacyStatus) || !AUTONOMY.has(legacyAutonomy)) throw new Error(`Cannot migrate invalid legacy index entry: ${id}`)
        string(rawMeta.goal, `legacy index.${id}.goal`)
        string(rawMeta.createdAt, `legacy index.${id}.createdAt`)
        if (rawMeta.updatedAt !== undefined) string(rawMeta.updatedAt, `legacy index.${id}.updatedAt`)
        const rawPlan = readJson(this.path(id, "plan.json"))
        const rawState = readJson(this.path(id, "state.json"))
        if (!object(rawPlan)) throw new Error(`Cannot migrate missing or invalid plan artifact: ${id}`)
        if (!object(rawState)) throw new Error(`Cannot migrate missing or invalid state artifact: ${id}`)
        plans.set(id, validateHorizonPlan(rawPlan.schemaVersion === undefined ? { schemaVersion: PARALLAX_SCHEMA_VERSION, ...rawPlan } : rawPlan, id))
        states.set(id, validateHorizonState(rawState.schemaVersion === undefined ? { schemaVersion: PARALLAX_SCHEMA_VERSION, ...rawState } : rawState, id))
        validateHorizonStateAgainstPlan(states.get(id)!, plans.get(id)!)
        const plan = plans.get(id)!
        if (rawMeta.goal !== plan.goal || rawMeta.createdAt !== plan.createdAt || legacyStatus !== plan.status || legacyAutonomy !== plan.autonomyLevel) {
          throw new Error(`Legacy index metadata does not match plan artifact: ${id}`)
        }
        // Parse every line before any artifact is changed. A malformed legacy decision must
        // fail the migration rather than being hidden behind a success marker.
        const decisionsPath = this.path(id, "decisions.jsonl")
        let decisionText: string
        try { decisionText = readFileSync(decisionsPath, "utf8") }
        catch (error) { throw new Error(`Cannot migrate decision artifact for ${id}: ${error instanceof Error ? error.message : String(error)}`) }
        decisionText.split("\n").filter(Boolean).forEach((line, index) => {
          try { validateHorizonDecision(JSON.parse(line) as unknown) }
          catch (error) { throw new Error(`Cannot migrate invalid decision ${index + 1} for ${id}: ${error instanceof Error ? error.message : String(error)}`) }
        })
      }
      const sessionRoot = join(this.root, "sessions")
      const artifactIds = existsSync(sessionRoot) ? readdirSync(sessionRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort() : []
      if (artifactIds.join("\0") !== indexedIds.join("\0")) throw new Error("Legacy Horizon index and session artifact directories do not match")

      const sessions: HorizonIndex["sessions"] = {}
      for (const id of indexedIds) {
        const plan = plans.get(id)!
        const rawMeta = rawIndex.sessions[id] as Record<string, unknown>
        sessions[id] = {
          goal: plan.goal,
          createdAt: plan.createdAt,
          updatedAt: typeof rawMeta.updatedAt === "string" && rawMeta.updatedAt.trim() ? rawMeta.updatedAt : updatedAt,
          status: plan.status,
          autonomyLevel: plan.autonomyLevel,
        }
      }
      const migratedIndex = validateHorizonIndex({ schemaVersion: PARALLAX_SCHEMA_VERSION, sessions })
      // Commit only already-validated values. The marker is deliberately last.
      for (const id of indexedIds) {
        atomicWriteJson(this.path(id, "plan.json"), plans.get(id))
        atomicWriteJson(this.path(id, "state.json"), states.get(id))
      }
      atomicWriteJson(indexPath, migratedIndex)
      atomicWriteText(join(this.root, ".claudecode-migrated"), `Backup: ${backup}\nMigrated: ${updatedAt}\n`)
    } catch (error) {
      // Roll back all non-lock artifacts from the backup if even an atomic commit write failed.
      for (const entry of readdirSync(this.root, { withFileTypes: true })) {
        if (entry.name !== ".locks") rmSync(join(this.root, entry.name), { recursive: true, force: true })
      }
      for (const entry of readdirSync(backup, { withFileTypes: true })) cpSync(join(backup, entry.name), join(this.root, entry.name), { recursive: true })
      throw new Error(`Legacy Horizon migration rolled back; backup retained at ${backup}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Explicitly migrate score-era features to empty, non-ready evidence state. */
  private migrateEvidenceStore(): void {
    const rawIndex = readJson(join(this.root, "index.json"))
    if (!object(rawIndex) || !object(rawIndex.sessions)) return
    for (const id of Object.keys(rawIndex.sessions)) {
      assertSafeId("session ID", id)
      const path = this.path(id, "plan.json")
      const raw = readJson(path)
      if (!object(raw) || !Array.isArray(raw.milestones)) continue
      let changed = false
      for (const [milestoneIndex, milestone] of raw.milestones.entries()) {
        if (!object(milestone) || !Array.isArray(milestone.features)) continue
        // Ordering and approval were added after the first Claude Code Horizon
        // stores. Preserve the existing array order and automatic advancement.
        if (milestone.order === undefined) {
          milestone.order = milestoneIndex + 1
          changed = true
        }
        if (milestone.requiresApproval === undefined) {
          milestone.requiresApproval = false
          changed = true
        }
        for (const [featureIndex, feature] of milestone.features.entries()) {
          if (!object(feature)) continue
          if (feature.order === undefined) {
            feature.order = featureIndex + 1
            changed = true
          }
          if (feature.evidence !== undefined) continue
          feature.evidence = emptyEvidence()
          feature.status = "pending"
          feature.subAgentSessionId = null
          if (object(feature.verification)) { feature.verification.passed = false; feature.verification.featureDigest = null }
          changed = true
        }
        if (changed && milestone.status === "completed") milestone.status = "pending"
      }
      if (!changed) continue
      raw.status = raw.milestones.some((milestone) => object(milestone) && milestone.status === "failed") ? "failed" : "planning"
      raw.completedAt = null
      const migrated = validateHorizonPlan({ ...raw, stats: { ...(object(raw.stats) ? raw.stats : {}), ...computePlanStats(raw as unknown as HorizonPlan) } }, id)
      const state = this.readState(id)
      if (state?.currentPhase === "complete") {
        state.currentPhase = "plan"; state.currentMilestoneId = null; state.currentFeatureId = null; state.activeSubAgents = []
        atomicWriteJson(this.path(id, "state.json"), validateHorizonState(state, id))
      }
      atomicWriteJson(path, migrated)
      this.updateIndex(id, migrated)
    }
  }

  private sessionDir(sessionId: string): string {
    const sessions = resolve(this.root, "sessions")
    const path = resolve(sessions, assertSafeId("session ID", sessionId))
    if (!path.startsWith(`${sessions}/`) && !path.startsWith(`${sessions}\\`)) throw new Error("Horizon session path escapes root")
    return path
  }
  private path(sessionId: string, name: string): string { return join(this.sessionDir(sessionId), name) }

  private transitionPath(sessionId: string): string { return this.path(sessionId, "transition.json") }
  private recoverAllTransactions(): void {
    const sessions = join(this.root, "sessions")
    if (!existsSync(sessions)) return
    for (const entry of readdirSync(sessions, { withFileTypes: true })) if (entry.isDirectory() && SAFE_ID.test(entry.name)) this.recoverPendingTransaction(entry.name)
  }
  private validateJournal(value: unknown, sessionId: string): HorizonTransitionJournal {
    if (!object(value) || !object(value.target)) throw new Error(`Invalid Horizon transition journal for ${sessionId}`)
    exactKeys(value, ["schemaVersion", "root", "sessionId", "operation", "createdAt", "target"], "transition journal")
    exactKeys(value.target, ["plan", "state", "activeChild", "index"], "transition journal target")
    const operations = new Set<HorizonTransitionOperation>(["begin-worker", "observe-receipt", "begin-auditor", "record-audit", "recover-active-child", "abort-active-child"])
    if (value.schemaVersion !== 1 || value.root !== this.root || value.sessionId !== sessionId || !operations.has(value.operation as HorizonTransitionOperation)) throw new Error(`Invalid Horizon transition journal identity for ${sessionId}`)
    const plan = validateHorizonPlan(value.target.plan, sessionId)
    const state = validateHorizonState(value.target.state, sessionId)
    validateHorizonStateAgainstPlan(state, plan)
    const activeChild = value.target.activeChild === null ? null : validateHorizonActiveChild(value.target.activeChild, this.root, sessionId)
    const expected = activeChild ? [activeChild.childRunId] : []
    if (JSON.stringify(state.activeSubAgents) !== JSON.stringify(expected) || (activeChild && state.currentFeatureId !== activeChild.featureId)) throw new Error(`Transition journal active child does not match state for ${sessionId}`)
    return { schemaVersion: 1, root: this.root, sessionId, operation: value.operation as HorizonTransitionOperation, createdAt: timestampString(value.createdAt, "transition.createdAt"), target: { plan, state, activeChild, index: validateHorizonIndex(value.target.index) } }
  }
  private recoverPendingTransaction(sessionId: string): void {
    const raw = readJson(this.transitionPath(sessionId))
    if (raw === null) return
    this.applyJournal(this.validateJournal(raw, sessionId), false)
  }
  private ensureRecovered(sessionId: string): void { this.withLock(() => this.recoverPendingTransaction(sessionId)) }
  private targetIndex(sessionId: string, plan: HorizonPlan, updatedAt: string): HorizonIndex {
    const index = this.readIndex()
    const previous = index.sessions[sessionId]
    index.sessions[sessionId] = { goal: plan.goal, createdAt: previous?.createdAt ?? plan.createdAt, updatedAt, status: plan.status, autonomyLevel: plan.autonomyLevel }
    return validateHorizonIndex(index)
  }
  private applyJournal(journal: HorizonTransitionJournal, injectFaults: boolean): void {
    const fault = (stage: HorizonFaultStage): void => { if (injectFaults) this.faultInjector?.(stage, journal.operation) }
    const { sessionId, target } = journal
    if (target.activeChild) { atomicWriteJson(this.activeChildPath(sessionId), target.activeChild); fault("active-child-written") }
    atomicWriteJson(this.path(sessionId, "plan.json"), target.plan); fault("plan-written")
    atomicWriteJson(this.path(sessionId, "state.json"), target.state); fault("state-written")
    atomicWriteJson(join(this.root, "index.json"), target.index); fault("index-written")
    if (!target.activeChild) { rmSync(this.activeChildPath(sessionId), { force: true }); fault("active-child-released") }
    rmSync(this.transitionPath(sessionId), { force: true })
    fault("journal-cleared")
  }
  private commitJournal(operation: HorizonTransitionOperation, sessionId: string, plan: HorizonPlan, state: HorizonState, activeChild: HorizonActiveChildLock | null): HorizonPlan {
    plan.stats = computePlanStats(plan)
    const validatedPlan = validateHorizonPlan(plan, sessionId)
    const validatedState = validateHorizonState(state, sessionId)
    validateHorizonStateAgainstPlan(validatedState, validatedPlan)
    const expected = activeChild ? [activeChild.childRunId] : []
    if (JSON.stringify(validatedState.activeSubAgents) !== JSON.stringify(expected) || (activeChild && validatedState.currentFeatureId !== activeChild.featureId)) throw new Error("Horizon transition state does not match its active child")
    const createdAt = now()
    const journal: HorizonTransitionJournal = { schemaVersion: 1, root: this.root, sessionId, operation, createdAt, target: { plan: validatedPlan, state: validatedState, activeChild, index: this.targetIndex(sessionId, validatedPlan, createdAt) } }
    atomicWriteJson(this.transitionPath(sessionId), journal)
    this.faultInjector?.("journal-written", operation)
    this.applyJournal(journal, true)
    return validatedPlan
  }

  loadConfig(): HorizonConfig {
    const value = readJson(join(this.root, "config.json"))
    return value === null ? { ...DEFAULT_HORIZON_CONFIG } : validateHorizonConfig(value)
  }
  saveConfig(config: HorizonConfig): void { this.withLock(() => atomicWriteJson(join(this.root, "config.json"), validateHorizonConfig(config))) }

  initSession(sessionId: string, goal: string, autonomyLevel: HorizonAutonomyLevel = this.loadConfig().autonomyLevel): HorizonPlan {
    return this.withLock(() => {
      assertSafeId("session ID", sessionId)
      if (!AUTONOMY.has(autonomyLevel)) throw new Error("Invalid autonomyLevel")
      if (this.readPlan(sessionId)) throw new Error(`Horizon session already exists: ${sessionId}`)
      const dir = this.sessionDir(sessionId)
      for (const child of ["research", "skills", "traces"]) mkdirSync(join(dir, child), { recursive: true })
      const plan: HorizonPlan = {
        schemaVersion: PARALLAX_SCHEMA_VERSION, sessionId, goal: string(goal, "goal"), autonomyLevel, status: "planning", createdAt: now(), completedAt: null,
        milestones: [], skills: { global: [], sessionScoped: [] },
        stats: { totalFeatures: 0, completedFeatures: 0, failedFeatures: 0, totalRetries: 0, estimatedCost: null },
      }
      const state: HorizonState = {
        schemaVersion: PARALLAX_SCHEMA_VERSION, sessionId, currentPhase: "research", activeSubAgents: [], currentMilestoneId: null,
        currentFeatureId: null, lastCheckpoint: now(), pausedAt: null, pauseReason: null,
      }
      atomicWriteJson(join(dir, "plan.json"), plan)
      atomicWriteJson(join(dir, "state.json"), state)
      atomicWriteText(join(dir, "decisions.jsonl"), "")
      this.updateIndex(sessionId, plan)
      return plan
    })
  }

  readPlan(sessionId: string): HorizonPlan | null {
    this.ensureRecovered(sessionId)
    const value = readJson(this.path(sessionId, "plan.json"))
    return value === null ? null : validateHorizonPlan(value, sessionId)
  }
  private activeChildPath(sessionId: string): string { return this.path(sessionId, "active-child.json") }
  readActiveChild(sessionId: string): HorizonActiveChildLock | null {
    this.ensureRecovered(sessionId)
    const value = readJson(this.activeChildPath(sessionId))
    if (value === null) return null
    return validateHorizonActiveChild(value, this.root, sessionId)
  }
  recoverActiveChild(sessionId: string, expectedFeatureId: string, expectedChildRunId: string, childAlive?: boolean): boolean {
    return this.withLock(() => {
      assertSafeId("feature ID", expectedFeatureId); assertSafeId("child run ID", expectedChildRunId)
      const lock = this.readActiveChild(sessionId)
      if (!lock) {
        const plan = this.readPlan(sessionId)
        const state = this.readState(sessionId)
        const hasPlanActiveChild = plan?.milestones.some((milestone) => milestone.features.some((feature) => feature.status === "in_progress"
          && ((feature.evidence.worker.childRunId !== null && feature.evidence.worker.receipt === null)
            || (feature.evidence.auditor.childRunId !== null && feature.evidence.auditor.verdict === null)))) === true
        if ((state?.activeSubAgents.length ?? 0) > 0 || hasPlanActiveChild) throw new Error("Active child recovery corruption: active state or plan evidence exists without a lock")
        return false
      }
      if (lock.featureId !== expectedFeatureId || lock.childRunId !== expectedChildRunId) throw new Error(`Active child identity mismatch: expected ${expectedFeatureId}/${expectedChildRunId}, found ${lock.featureId}/${lock.childRunId}`)
      const plan = this.readPlan(sessionId)
      const state = this.readState(sessionId)
      if (!plan) throw new Error(`Active child recovery corruption: Horizon plan not found for ${sessionId}`)
      if (!state) throw new Error(`Active child recovery corruption: Horizon state not found for ${sessionId}`)
      if (state.currentFeatureId !== lock.featureId || state.activeSubAgents.length !== 1 || state.activeSubAgents[0] !== lock.childRunId) {
        throw new Error(`Active child recovery corruption: state does not match ${lock.role} ${lock.featureId}/${lock.childRunId}`)
      }
      let milestone: HorizonMilestone
      let feature: HorizonFeature
      try { ({ milestone, feature } = this.locateFeature(plan, lock.featureId)) }
      catch { throw new Error(`Active child recovery corruption: plan has no feature ${lock.featureId}`) }
      const roleEvidence = lock.role === "worker" ? feature.evidence.worker : feature.evidence.auditor
      const roleIncomplete = lock.role === "worker" ? feature.evidence.worker.receipt === null : feature.evidence.auditor.verdict === null
      const workerIdentityMatches = lock.role !== "worker" || feature.subAgentSessionId === lock.childRunId
      if (feature.status !== "in_progress" || roleEvidence.childRunId !== lock.childRunId || roleEvidence.startedAt !== lock.acquiredAt || !roleIncomplete || !workerIdentityMatches) {
        throw new Error(`Active child recovery corruption: plan evidence does not match ${lock.role} ${lock.featureId}/${lock.childRunId}`)
      }
      if (Date.parse(lock.leaseUntil) > this.currentTime()) throw new Error("Active child lease has not expired")
      if (childAlive === undefined) throw new Error("Cannot recover an abandoned child without affirmative liveness evidence that it is dead")
      if (childAlive) throw new Error("Cannot recover active child because liveness evidence says it is still alive")
      if (lock.role === "worker") {
        feature.evidence.worker = emptyEvidence().worker; feature.evidence.auditor = emptyEvidence().auditor
        feature.status = "pending"; feature.subAgentSessionId = null; milestone.status = "pending"
      } else {
        feature.evidence.auditor = emptyEvidence().auditor
      }
      state.activeSubAgents = []; state.pausedAt = this.currentTimestamp(); state.pauseReason = `Abandoned ${lock.role} ${lock.childRunId} requires recovery`
      this.commitJournal("recover-active-child", sessionId, plan, state, null)
      return true
    })
  }
  abortActiveChild(sessionId: string, expectedFeatureId: string, expectedChildRunId: string, reason: string): boolean {
    return this.withLock(() => {
      const lock = this.readActiveChild(sessionId)
      if (!lock) return false
      if (lock.featureId !== expectedFeatureId || lock.childRunId !== expectedChildRunId) throw new Error(`Active child identity mismatch: expected ${expectedFeatureId}/${expectedChildRunId}, found ${lock.featureId}/${lock.childRunId}`)
      const plan = this.readPlan(sessionId); const state = this.readState(sessionId)
      if (!plan || !state) throw new Error("Active child abort requires matching plan and state")
      const { milestone, feature } = this.locateFeature(plan, lock.featureId)
      if (lock.role === "worker") {
        feature.evidence.worker = emptyEvidence().worker; feature.evidence.auditor = emptyEvidence().auditor
        feature.status = "pending"; feature.subAgentSessionId = null; milestone.status = "pending"
      } else feature.evidence.auditor = emptyEvidence().auditor
      state.activeSubAgents = []; state.pausedAt = this.currentTimestamp(); state.pauseReason = boundedSummary(reason, "abort reason")
      this.commitJournal("abort-active-child", sessionId, plan, state, null)
      return true
    })
  }
  private makeActiveChild(sessionId: string, featureId: string, role: "worker" | "auditor", childRunId: string): HorizonActiveChildLock {
    if (this.readActiveChild(sessionId)) throw new Error("Another Horizon child is already active for this session")
    assertSafeId("child run ID", childRunId)
    const acquiredAt = this.currentTimestamp()
    return { schemaVersion: 1, root: this.root, sessionId, featureId, role, childRunId, acquiredAt, leaseUntil: new Date(Date.parse(acquiredAt) + CHILD_LEASE_MS).toISOString() }
  }
  private locateFeature(plan: HorizonPlan, featureId: string): { milestone: HorizonMilestone; feature: HorizonFeature } {
    const milestone = plan.milestones.find((item) => item.features.some((feature) => feature.id === featureId))
    const feature = milestone?.features.find((item) => item.id === featureId)
    if (!milestone || !feature) throw new Error(`Feature '${featureId}' was not found`)
    return { milestone, feature }
  }
  private childIdUsed(plan: HorizonPlan, childRunId: string): boolean {
    return plan.milestones.some((milestone) => milestone.features.some((feature) => feature.evidence.worker.childRunId === childRunId || feature.evidence.auditor.childRunId === childRunId
      || feature.evidence.history.some((attempt) => attempt.worker.childRunId === childRunId || attempt.auditor.childRunId === childRunId)))
  }
  private childIdUsedAnywhere(childRunId: string): boolean {
    return this.listSessions().some(({ id }) => { const plan = this.readPlan(id); return plan ? this.childIdUsed(plan, childRunId) : false })
  }
  private receiptIdUsedAnywhere(receiptId: string): boolean {
    return this.listSessions().some(({ id }) => this.readPlan(id)?.milestones.some((milestone) => milestone.features.some((feature) => feature.evidence.worker.receipt?.id === receiptId
      || feature.evidence.history.some((attempt) => attempt.worker.receipt?.id === receiptId))) === true)
  }
  private commitTransition(sessionId: string, plan: HorizonPlan): HorizonPlan {
    plan.stats = computePlanStats(plan)
    const validated = validateHorizonPlan(plan, sessionId)
    atomicWriteJson(this.path(sessionId, "plan.json"), validated)
    this.updateIndex(sessionId, validated)
    return validated
  }
  beginWorker(sessionId: string, featureId: string, childRunId: string): HorizonPlan {
    return this.withLock(() => {
      const plan = this.readPlan(sessionId); if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const { milestone, feature } = this.locateFeature(plan, featureId)
      if (plan.status === "completed" || feature.status === "completed") throw new Error(`Feature ${featureId} is already completed`)
      if (plan.status === "failed") throw new Error(`Horizon session ${sessionId} is failed and blocked`)
      if (this.childIdUsedAnywhere(childRunId)) throw new Error(`Child run ID ${childRunId} has already been used`)
      const cap = Math.min(feature.maxAttempts, this.loadConfig().maxRetryCycles)
      if (feature.attempts >= cap) throw new Error(`Retry cap reached for ${featureId}`)
      if (feature.evidence.worker.childRunId && feature.evidence.worker.receipt === null) throw new Error(`Previous worker for ${featureId} has not produced a receipt`)
      if (feature.evidence.worker.receipt && feature.evidence.auditor.verdict === null) throw new Error(`Feature ${featureId} must be audited before corrective work begins`)
      if (feature.evidence.auditor.verdict === "accept") throw new Error(`Accepted feature ${featureId} cannot restart`)
      const activeChild = this.makeActiveChild(sessionId, featureId, "worker", childRunId)
      const priorEvidence = structuredClone(feature.evidence)
      feature.attempts += 1; feature.status = "in_progress"; feature.subAgentSessionId = childRunId
      feature.evidence = emptyEvidence()
      if (priorEvidence.worker.receipt && priorEvidence.auditor.verdict) feature.evidence.history = [...priorEvidence.history, { worker: priorEvidence.worker, auditor: priorEvidence.auditor }]
      else feature.evidence.history = priorEvidence.history
      feature.evidence.worker = { childRunId, startedAt: activeChild.acquiredAt, completedAt: null, receipt: null, summary: null, traceId: null }
      feature.verification = { ...feature.verification, passed: false, featureDigest: null }
      milestone.status = "in_progress"; plan.status = "executing"; plan.completedAt = null
      const state = this.readState(sessionId)!; state.currentPhase = "execute"; state.currentMilestoneId = milestone.id; state.currentFeatureId = featureId; state.activeSubAgents = [childRunId]; state.pausedAt = null; state.pauseReason = null
      return this.commitJournal("begin-worker", sessionId, plan, state, activeChild)
    })
  }
  observeReceipt(projectRoot: string, sessionId: string, featureId: string, receiptId: string, summary: string, traceId: string | null = null): HorizonPlan {
    return this.withLock(() => {
      assertSafeId("receipt ID", receiptId); boundedSummary(summary, "worker summary"); if (traceId !== null) assertSafeId("trace ID", traceId)
      const plan = this.readPlan(sessionId); if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const { feature } = this.locateFeature(plan, featureId); const workerId = feature.evidence.worker.childRunId
      if (!workerId) throw new Error(`Feature ${featureId} has no active worker`)
      const lock = this.readActiveChild(sessionId); if (!lock || lock.role !== "worker" || lock.featureId !== featureId || lock.childRunId !== workerId) throw new Error("Worker receipt does not match the active child lock")
      const receipt = new VerificationLedger(projectRoot).read().find((record) => record.id === receiptId)
      if (!receipt) throw new Error(`Verification receipt '${receiptId}' was not found in the project ledger`)
      if (receipt.sessionId !== workerId) throw new Error(`Receipt ${receiptId} belongs to ${receipt.sessionId}, not worker ${workerId}`)
      if (resolve(receipt.cwd) !== resolve(projectRoot)) throw new Error(`Receipt ${receiptId} was produced in a different project root`)
      if (this.receiptIdUsedAnywhere(receiptId)) throw new Error(`Verification receipt ${receiptId} has already been bound`)
      const workerStartedAt = feature.evidence.worker.startedAt!
      const receiptStartedAt = Date.parse(receipt.startedAt)
      const durationMs = receipt.durationMs
      const observedAt = this.currentTime()
      if (!Number.isFinite(receiptStartedAt)) throw new Error(`Receipt ${receiptId} has an invalid startedAt timestamp`)
      if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error(`Receipt ${receiptId} has an impossible durationMs`)
      const receiptEndedAt = receiptStartedAt + durationMs
      if (!Number.isFinite(receiptEndedAt) || receiptEndedAt < receiptStartedAt) throw new Error(`Receipt ${receiptId} has an impossible logical end`)
      if (receiptStartedAt < Date.parse(workerStartedAt)) throw new Error(`Receipt ${receiptId} started before worker ${workerId}; equality with worker start is allowed`)
      if (receiptStartedAt > observedAt + RECEIPT_CLOCK_SKEW_MS) throw new Error(`Receipt ${receiptId} starts materially in the future`)
      if (receiptEndedAt > observedAt + RECEIPT_CLOCK_SKEW_MS) throw new Error(`Receipt ${receiptId} ends materially in the future or has an impossible duration`)
      const observedTimestamp = new Date(observedAt).toISOString()
      feature.evidence.worker.receipt = { id: receipt.id, verdict: receipt.verdict, sessionId: receipt.sessionId, source: receipt.source, cwd: receipt.cwd, startedAt: receipt.startedAt, observedAt: observedTimestamp }
      feature.evidence.worker.completedAt = observedTimestamp; feature.evidence.worker.summary = summary; feature.evidence.worker.traceId = traceId
      const state = this.readState(sessionId)!; state.currentPhase = "audit"; state.activeSubAgents = []
      return this.commitJournal("observe-receipt", sessionId, plan, state, null)
    })
  }
  beginAuditor(sessionId: string, featureId: string, childRunId: string): HorizonPlan {
    return this.withLock(() => {
      const plan = this.readPlan(sessionId); if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const { feature } = this.locateFeature(plan, featureId)
      if (!feature.evidence.worker.receipt) throw new Error(`Feature ${featureId} requires an observed receipt before audit`)
      if (feature.evidence.auditor.childRunId) throw new Error(`Feature ${featureId} already has an auditor for this attempt`)
      if (this.childIdUsedAnywhere(childRunId)) throw new Error(`Child run ID ${childRunId} has already been used`)
      const activeChild = this.makeActiveChild(sessionId, featureId, "auditor", childRunId)
      feature.evidence.auditor = { childRunId, startedAt: activeChild.acquiredAt, completedAt: null, verdict: null, summary: null, traceId: null }
      const state = this.readState(sessionId)!; state.currentPhase = "audit"; state.activeSubAgents = [childRunId]
      return this.commitJournal("begin-auditor", sessionId, plan, state, activeChild)
    })
  }
  recordAudit(sessionId: string, featureId: string, childRunId: string, verdict: HorizonAuditVerdict, summary: string, traceId: string | null = null): HorizonPlan {
    return this.withLock(() => {
      if (!AUDIT_VERDICTS.has(verdict)) throw new Error(`Invalid audit verdict: ${verdict}`)
      boundedSummary(summary, "auditor summary"); if (traceId !== null) assertSafeId("trace ID", traceId)
      const plan = this.readPlan(sessionId); if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const { milestone, feature } = this.locateFeature(plan, featureId)
      if (feature.evidence.auditor.childRunId !== childRunId) throw new Error("Audit child does not match the assigned independent auditor")
      if (verdict === "accept" && feature.evidence.worker.receipt?.verdict !== "pass") throw new Error("A non-pass verification receipt cannot be accepted")
      const lock = this.readActiveChild(sessionId)
      if (!lock || lock.role !== "auditor" || lock.featureId !== featureId || lock.childRunId !== childRunId) throw new Error(`Active auditor lock does not match child ${childRunId}`)
      feature.evidence.auditor.verdict = verdict; feature.evidence.auditor.completedAt = now(); feature.evidence.auditor.summary = summary; feature.evidence.auditor.traceId = traceId
      const accepted = verdict === "accept" && feature.evidence.worker.receipt?.verdict === "pass"
      const cap = Math.min(feature.maxAttempts, this.loadConfig().maxRetryCycles)
      if (accepted) feature.status = "completed"
      else if (feature.attempts >= cap) feature.status = "failed"
      else feature.status = "pending"
      if (feature.status === "failed") { milestone.status = "failed"; plan.status = "failed" }
      else if (this.loadConfig().autoApproveMilestones && milestone.features.every((item) => item.status === "completed")) milestone.status = "completed"
      if (plan.milestones.length > 0 && plan.milestones.every((item) => item.status === "completed")) { plan.status = "completed"; plan.completedAt = now() }
      const state = this.readState(sessionId)!; state.activeSubAgents = []; state.currentFeatureId = feature.status === "pending" ? featureId : null; state.currentMilestoneId = feature.status === "pending" ? milestone.id : null
      if (plan.status === "completed") state.currentPhase = "complete"
      else if (feature.status === "failed") { state.currentPhase = "audit"; state.pausedAt = now(); state.pauseReason = `Retry cap reached for ${featureId}` }
      else state.currentPhase = "execute"
      return this.commitJournal("record-audit", sessionId, plan, state, null)
    })
  }
  writePlan(sessionId: string, value: unknown, allowVerificationChanges = false): HorizonPlan {
    return this.withLock(() => {
      if (!this.readState(sessionId)) throw new Error(`Horizon session not initialized: ${sessionId}`)
      const existing = this.readPlan(sessionId)
      if (existing && object(value) && Array.isArray(value.milestones)) {
        const prior = new Map(existing.milestones.flatMap((milestone) => milestone.features.map((feature) => [feature.id, feature] as const)))
        for (const rawMilestone of value.milestones) {
          if (!object(rawMilestone) || !Array.isArray(rawMilestone.features)) continue
          for (const rawFeature of rawMilestone.features) {
            if (!object(rawFeature) || typeof rawFeature.id !== "string") continue
            const before = prior.get(rawFeature.id); if (!before) continue
            if (rawFeature.attempts !== before.attempts || rawFeature.status !== before.status || rawFeature.subAgentSessionId !== before.subAgentSessionId || JSON.stringify(rawFeature.evidence) !== JSON.stringify(before.evidence)) {
              throw new Error(`Feature ${before.id} execution state may only be changed by Horizon transitions`)
            }
          }
        }
      }
      const plan = validateHorizonPlan(value, sessionId)
      if (existing?.status === "completed" && JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error("Completed Horizon plans are immutable; create a new feature revision or session")
      const cap = this.loadConfig().maxRetryCycles
      if (plan.milestones.some((milestone) => milestone.features.some((feature) => feature.maxAttempts > cap))) throw new Error(`Feature maxAttempts exceeds configured maxRetryCycles (${cap})`)
      const priorFeatures = new Map(existing?.milestones.flatMap((milestone) => milestone.features.map((feature) => [feature.id, feature] as const)) ?? [])
      const nextFeatureIds = new Set(plan.milestones.flatMap((milestone) => milestone.features.map((feature) => feature.id)))
      for (const [featureId, prior] of priorFeatures) {
        if ((prior.evidence.worker.childRunId || prior.evidence.auditor.childRunId) && !nextFeatureIds.has(featureId)) throw new Error(`Feature ${featureId} with execution evidence cannot be removed`)
      }
      for (const feature of plan.milestones.flatMap((milestone) => milestone.features)) {
        const prior = priorFeatures.get(feature.id)
        if (!prior) {
          if (feature.status !== "pending" || feature.attempts !== 0 || feature.subAgentSessionId !== null || feature.verification.passed || feature.verification.featureDigest !== null || JSON.stringify(feature.evidence) !== JSON.stringify(emptyEvidence())) {
            throw new Error(`New feature ${feature.id} must begin pending with empty execution evidence`)
          }
          continue
        }
        if (JSON.stringify(prior.evidence) !== JSON.stringify(feature.evidence)) throw new Error(`Feature ${feature.id} evidence may only be changed by Horizon transitions`)
        if (prior.status !== feature.status || prior.attempts !== feature.attempts || prior.subAgentSessionId !== feature.subAgentSessionId) throw new Error(`Feature ${feature.id} execution state may only be changed by Horizon transitions`)
        if (!allowVerificationChanges && JSON.stringify(prior.verification) !== JSON.stringify(feature.verification)) throw new Error(`Feature ${feature.id} advisory evaluation may only be updated by horizon_evaluate_subagent`)
        const definitionChanged = featureVerificationDigest(existing!.goal, prior) !== featureVerificationDigest(plan.goal, feature)
        if (definitionChanged && (prior.evidence.worker.childRunId || prior.evidence.auditor.childRunId)) throw new Error(`Feature ${feature.id} definition cannot change after execution evidence exists`)
      }
      atomicWriteJson(this.path(sessionId, "plan.json"), plan)
      this.updateIndex(sessionId, plan)
      if (plan.status === "completed") {
        const state = this.readState(sessionId)
        if (state && state.currentPhase !== "complete") {
          state.currentPhase = "complete"
          state.currentMilestoneId = null
          state.currentFeatureId = null
          state.lastCheckpoint = now()
          atomicWriteJson(this.path(sessionId, "state.json"), validateHorizonState(state, sessionId))
        }
      }
      return plan
    })
  }
  updateFeature(sessionId: string, featureId: string, updates: Partial<HorizonFeature>, allowVerification = false): HorizonPlan | null {
    return this.withLock(() => {
      if (updates.verification !== undefined && !allowVerification) throw new Error("Feature verification may only be updated by horizon_evaluate_subagent")
      const plan = this.readPlan(sessionId)
      if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const milestone = plan.milestones.find((item) => item.features.some((candidate) => candidate.id === featureId))
      const feature = milestone?.features.find((item) => item.id === featureId)
      if (!feature || !milestone) return null
      if ((updates.status !== undefined && updates.status !== feature.status) || updates.attempts !== undefined || updates.subAgentSessionId !== undefined || updates.evidence !== undefined) {
        throw new Error("Feature execution state may only be changed by begin worker, receipt, and audit transitions")
      }
      const next = { ...feature, ...updates }
      if (updates.status === "in_progress" && feature.status !== "in_progress" && updates.attempts === undefined) next.attempts = feature.attempts + 1
      if (next.attempts > Math.min(next.maxAttempts, this.loadConfig().maxRetryCycles)) throw new Error(`Retry cap reached for ${featureId}`)
      Object.assign(feature, validateFeature(next, `feature ${featureId}`))
      const config = this.loadConfig()
      if (feature.status === "in_progress") {
        milestone.status = "in_progress"
        if (plan.status === "planning") plan.status = "executing"
      }
      if (config.autoApproveMilestones && milestone.features.length > 0 && milestone.features.every((candidate) => candidate.status === "completed")) milestone.status = "completed"
      if (plan.milestones.length > 0 && plan.milestones.every((candidate) => candidate.status === "completed")) {
        plan.status = "completed"
        plan.completedAt = now()
      }
      if (feature.status === "failed" && feature.attempts >= Math.min(feature.maxAttempts, config.maxRetryCycles)) {
        milestone.status = "failed"
        plan.status = "failed"
        if (config.pauseOnCriticalFailure) {
          const state = this.readState(sessionId)
          if (state) {
            state.pausedAt = now()
            state.pauseReason = `Retry cap reached for ${featureId}`
            this.writeState(sessionId, state)
          }
        }
      }
      plan.stats = computePlanStats(plan)
      return this.writePlan(sessionId, plan, allowVerification)
    })
  }
  recordEvaluation(sessionId: string, featureId: string, verification: Omit<HorizonFeature["verification"], "featureDigest">, expectedFeatureDigest: string): HorizonPlan | null {
    return this.withLock(() => {
      const plan = this.readPlan(sessionId)
      if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const feature = plan.milestones.flatMap((milestone) => milestone.features).find((candidate) => candidate.id === featureId)
      if (!feature) return null
      const currentDigest = featureVerificationDigest(plan.goal, feature)
      if (currentDigest !== expectedFeatureDigest) throw new Error(`Feature ${featureId} changed while verification was running; evaluate the new revision again`)
      return this.updateFeature(sessionId, featureId, { verification: { ...verification, passed: false, featureDigest: currentDigest } }, true)
    })
  }

  updateMilestone(sessionId: string, milestoneId: string, status: HorizonItemStatus): HorizonPlan | null {
    return this.withLock(() => {
      if (!ITEM_STATUSES.has(status)) throw new Error(`Invalid milestone status: ${status}`)
      const plan = this.readPlan(sessionId)
      if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const milestone = plan.milestones.find((item) => item.id === milestoneId)
      if (!milestone) return null
      if (status === "completed" && (milestone.features.length === 0 || milestone.features.some((feature) => feature.status !== "completed"))) throw new Error(`Cannot complete milestone ${milestoneId} before every feature completes`)
      milestone.status = status
      if (status === "in_progress" && plan.status === "planning") plan.status = "executing"
      if (plan.milestones.length > 0 && plan.milestones.every((candidate) => candidate.status === "completed")) {
        plan.status = "completed"
        plan.completedAt = now()
      }
      return this.writePlan(sessionId, plan)
    })
  }
  readState(sessionId: string): HorizonState | null {
    this.ensureRecovered(sessionId)
    const value = readJson(this.path(sessionId, "state.json"))
    return value === null ? null : validateHorizonState(value, sessionId)
  }
  writeState(sessionId: string, value: unknown): HorizonState {
    return this.withLock(() => {
      const plan = this.readPlan(sessionId)
      if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const state = validateHorizonState(value, sessionId)
      const active = this.readActiveChild(sessionId)
      const expectedChildren = active ? [active.childRunId] : []
      if (JSON.stringify(state.activeSubAgents) !== JSON.stringify(expectedChildren)) throw new Error("Horizon activeSubAgents must match the durable active-child lock")
      if (active && state.currentFeatureId !== active.featureId) throw new Error("Horizon currentFeatureId must match the durable active-child lock")
      validateHorizonStateAgainstPlan(state, plan)
      state.lastCheckpoint = now()
      atomicWriteJson(this.path(sessionId, "state.json"), state)
      return state
    })
  }
  appendDecision(sessionId: string, value: unknown): HorizonDecision {
    return this.withLock(() => {
      if (!this.readPlan(sessionId)) throw new Error(`Horizon session not found: ${sessionId}`)
      const decision = validateHorizonDecision(value)
      mkdirSync(dirname(this.path(sessionId, "decisions.jsonl")), { recursive: true })
      appendFileSync(this.path(sessionId, "decisions.jsonl"), `${JSON.stringify(decision)}\n`, "utf8")
      const confidenceValue = decision.confidence === "high" ? 0.9 : decision.confidence === "medium" ? 0.7 : 0.4
      if (confidenceValue < this.loadConfig().decisionConfidenceThreshold) {
        const state = this.readState(sessionId)
        if (state) {
          state.pausedAt = now()
          state.pauseReason = `Decision confidence ${decision.confidence} is below configured threshold`
          this.writeState(sessionId, state)
        }
      }
      return decision
    })
  }
  readDecisions(sessionId: string): HorizonDecision[] {
    const path = this.path(sessionId, "decisions.jsonl")
    try {
      return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, index) => {
        try { return validateHorizonDecision(JSON.parse(line) as unknown) }
        catch (error) { throw new Error(`Invalid decision record ${index + 1}: ${String(error)}`) }
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
  }

  writeResearch(sessionId: string, findings: string, sources: Record<string, string>): void {
    this.withLock(() => {
      if (!this.readPlan(sessionId)) throw new Error(`Horizon session not found: ${sessionId}`)
      if (!Object.values(sources).every((value) => typeof value === "string")) throw new Error("Research sources must contain string values")
      atomicWriteText(this.path(sessionId, join("research", "findings.md")), findings)
      atomicWriteJson(this.path(sessionId, join("research", "sources.json")), sources)
    })
  }
  readResearch(sessionId: string): { findings: string | null; sources: Record<string, string> } {
    let findings: string | null = null
    try { findings = readFileSync(this.path(sessionId, join("research", "findings.md")), "utf8") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    const rawSources = readJson(this.path(sessionId, join("research", "sources.json")))
    if (rawSources !== null && (!object(rawSources) || !Object.values(rawSources).every((value) => typeof value === "string"))) throw new Error("Invalid research sources schema")
    return { findings, sources: (rawSources ?? {}) as Record<string, string> }
  }

  createSkill(sessionId: string, name: string, description: string, content: string): string {
    return this.withLock(() => {
    assertSafeId("skill name", name)
    if (!SKILL_NAME.test(name)) throw new Error("Skill name must be lowercase kebab-case")
    const plan = this.readPlan(sessionId)
    if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
    const path = this.path(sessionId, join("skills", name, "SKILL.md"))
    // JSON double-quoted strings are valid YAML scalars and safely encode colons, quotes and newlines.
    const frontmatter = ["---", `name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(description.slice(0, 1024))}`, "metadata:", `  parallax-session: ${JSON.stringify(sessionId)}`, "---", "", content.trim(), ""].join("\n")
    atomicWriteText(path, frontmatter)
    if (!plan.skills.sessionScoped.includes(name)) {
      plan.skills.sessionScoped.push(name)
      this.writePlan(sessionId, plan)
    }
    return path
    })
  }

  listSkills(sessionId: string): string[] {
    const dir = this.path(sessionId, "skills")
    try { return readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md"))).sort() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
  }

  saveTrace(sessionId: string, traceId: string, value: unknown): string {
    return this.withLock(() => {
    if (!this.readPlan(sessionId)) throw new Error(`Horizon session not found: ${sessionId}`)
    assertSafeId("trace ID", traceId)
    if (!object(value)) throw new Error("Trace data must be an object")
    const path = this.path(sessionId, join("traces", `${traceId}.json`))
    atomicWriteJson(path, value)
    return path
    })
  }
  listTraces(sessionId: string): string[] {
    const dir = this.path(sessionId, "traces")
    try { return readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error }
  }
  status(sessionId: string): { plan: HorizonPlan | null; state: HorizonState | null; activeChild: HorizonActiveChildLock | null; decisions: HorizonDecision[]; research: { findings: string | null; sources: Record<string, string> }; skills: string[]; traces: string[] } {
    return { plan: this.readPlan(sessionId), state: this.readState(sessionId), activeChild: this.readActiveChild(sessionId), decisions: this.readDecisions(sessionId), research: this.readResearch(sessionId), skills: this.listSkills(sessionId), traces: this.listTraces(sessionId) }
  }

  listSessions(): Array<{ id: string; meta: HorizonIndex["sessions"][string] }> {
    const index = this.readIndex()
    return Object.entries(index.sessions).map(([id, meta]) => ({ id, meta })).sort((a, b) => a.id.localeCompare(b.id))
  }

  private readIndex(): HorizonIndex {
    const value = readJson(join(this.root, "index.json"))
    return value === null ? { schemaVersion: PARALLAX_SCHEMA_VERSION, sessions: {} } : validateHorizonIndex(value)
  }
  private updateIndex(sessionId: string, plan: HorizonPlan): void {
    const index = this.readIndex()
    const previous = index.sessions[sessionId]
    index.sessions[sessionId] = { goal: plan.goal, createdAt: previous?.createdAt ?? plan.createdAt, updatedAt: now(), status: plan.status, autonomyLevel: plan.autonomyLevel }
    atomicWriteJson(join(this.root, "index.json"), index)
  }
}

// Functional API retained for callers converting from parallax-opencode.
function defaultStore(): HorizonStore { return new HorizonStore() }
export function loadHorizonConfig(): HorizonConfig { return defaultStore().loadConfig() }
export function saveHorizonConfig(config: HorizonConfig): void { defaultStore().saveConfig(config) }
export function initHorizonSession(sessionId: string, goal: string, autonomyLevel: HorizonAutonomyLevel): HorizonPlan { return defaultStore().initSession(sessionId, goal, autonomyLevel) }
export function readHorizonPlan(sessionId: string): HorizonPlan | null { return defaultStore().readPlan(sessionId) }
export function writeHorizonPlan(sessionId: string, plan: HorizonPlan): HorizonPlan { return defaultStore().writePlan(sessionId, plan) }
export function updateHorizonFeature(sessionId: string, featureId: string, updates: Partial<HorizonFeature>): HorizonPlan | null { return defaultStore().updateFeature(sessionId, featureId, updates) }
export function beginHorizonWorker(sessionId: string, featureId: string, childRunId: string): HorizonPlan { return defaultStore().beginWorker(sessionId, featureId, childRunId) }
export function observeHorizonReceipt(projectRoot: string, sessionId: string, featureId: string, receiptId: string, summary: string, traceId: string | null = null): HorizonPlan { return defaultStore().observeReceipt(projectRoot, sessionId, featureId, receiptId, summary, traceId) }
export function beginHorizonAuditor(sessionId: string, featureId: string, childRunId: string): HorizonPlan { return defaultStore().beginAuditor(sessionId, featureId, childRunId) }
export function recordHorizonAudit(sessionId: string, featureId: string, childRunId: string, verdict: HorizonAuditVerdict, summary: string, traceId: string | null = null): HorizonPlan { return defaultStore().recordAudit(sessionId, featureId, childRunId, verdict, summary, traceId) }
export function recoverHorizonActiveChild(sessionId: string, expectedFeatureId: string, expectedChildRunId: string, childAlive?: boolean): boolean { return defaultStore().recoverActiveChild(sessionId, expectedFeatureId, expectedChildRunId, childAlive) }
export function updateHorizonMilestone(sessionId: string, milestoneId: string, status: HorizonItemStatus): HorizonPlan | null { return defaultStore().updateMilestone(sessionId, milestoneId, status) }
export function readHorizonState(sessionId: string): HorizonState | null { return defaultStore().readState(sessionId) }
export function writeHorizonState(sessionId: string, state: HorizonState): HorizonState { return defaultStore().writeState(sessionId, state) }
export function appendHorizonDecision(sessionId: string, decision: HorizonDecision): HorizonDecision { return defaultStore().appendDecision(sessionId, decision) }
export function readHorizonDecisions(sessionId: string): HorizonDecision[] { return defaultStore().readDecisions(sessionId) }
export function writeHorizonResearch(sessionId: string, findings: string, sources: Record<string, string>): void { defaultStore().writeResearch(sessionId, findings, sources) }
export function readHorizonResearch(sessionId: string): { findings: string | null; sources: Record<string, string> } { return defaultStore().readResearch(sessionId) }
export function createHorizonSkill(sessionId: string, name: string, description: string, content: string): string { return defaultStore().createSkill(sessionId, name, description, content) }
export function listHorizonSkills(sessionId: string): string[] { return defaultStore().listSkills(sessionId) }
export function saveHorizonSubAgentTrace(sessionId: string, traceId: string, traceData: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(traceData) as unknown } catch { throw new Error("Sub-agent trace must be valid JSON") }
  return defaultStore().saveTrace(sessionId, traceId, parsed)
}
export function listHorizonTraces(sessionId: string): string[] { return defaultStore().listTraces(sessionId) }
export function listHorizonSessions(): Array<{ id: string; meta: HorizonIndex["sessions"][string] }> { return defaultStore().listSessions() }
export function getHorizonSessionStatus(sessionId: string): ReturnType<HorizonStore["status"]> { return defaultStore().status(sessionId) }
