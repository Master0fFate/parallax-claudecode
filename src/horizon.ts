import { randomUUID } from "node:crypto"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { withDirectoryLock } from "./lock.js"
import { atomicWriteJson, atomicWriteText } from "./state.js"
import {
  PARALLAX_SCHEMA_VERSION,
  type HorizonAutonomyLevel,
  type HorizonConfig,
  type HorizonDecision,
  type HorizonFeature,
  type HorizonIndex,
  type HorizonItemStatus,
  type HorizonMilestone,
  type HorizonPlan,
  type HorizonState,
} from "./types.js"

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ITEM_STATUSES = new Set(["pending", "in_progress", "completed", "failed"])
const PLAN_STATUSES = new Set(["planning", "executing", "completed", "failed"])
const AUTONOMY = new Set(["full", "semi", "supervised"])
const PHASES = new Set(["research", "plan", "execute", "audit", "complete"])
const CONFIDENCE = new Set(["high", "medium", "low"])

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

export function assertSafeId(kind: string, value: string): string {
  if (!SAFE_ID.test(value) || value === "." || value === ".." || basename(value) !== value) throw new Error(`Invalid ${kind}: ${value}`)
  return value
}

function validateVerification(value: unknown, label: string): HorizonFeature["verification"] {
  if (!object(value) || typeof value.passed !== "boolean") throw new Error(`${label} verification is invalid`)
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
  const id = assertSafeId("feature ID", string(value.id, `${label}.id`))
  const status = string(value.status, `${label}.status`) as HorizonItemStatus
  if (!ITEM_STATUSES.has(status)) throw new Error(`${label}.status is invalid`)
  const protocolLevel = string(value.protocolLevel, `${label}.protocolLevel`)
  if (protocolLevel !== "none" && protocolLevel !== "full") throw new Error(`${label}.protocolLevel is invalid`)
  const attempts = integer(value.attempts, `${label}.attempts`)
  const maxAttempts = integer(value.maxAttempts, `${label}.maxAttempts`, 1)
  if (attempts > maxAttempts) throw new Error(`${label}.attempts exceeds maxAttempts`)
  return {
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
    skillsRequired: strings(value.skillsRequired, `${label}.skillsRequired`),
    skillsGenerated: strings(value.skillsGenerated, `${label}.skillsGenerated`),
  }
}

function validateMilestone(value: unknown, index: number): HorizonMilestone {
  const label = `milestones[${index}]`
  if (!object(value) || !Array.isArray(value.features)) throw new Error(`${label} is invalid`)
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
      // Same-schema compatibility: bind previously passing 1.0 records to the definition
      // they contained when first read. Subsequent writes enforce provenance and immutability.
      if (feature.verification.passed && feature.verification.featureDigest === null) feature.verification.featureDigest = featureVerificationDigest(plan.goal, feature)
      if (feature.verification.passed && feature.verification.issues.length > 0) throw new Error(`Passing feature ${feature.id} cannot retain verification issues`)
      if (feature.verification.passed && (feature.verification.score === null || feature.verification.score < 75 || !feature.verification.testResults?.trim())) {
        throw new Error(`Passing feature ${feature.id} requires a score of at least 75 and independent verification evidence`)
      }
      if (feature.verification.passed && feature.verification.featureDigest !== featureVerificationDigest(plan.goal, feature)) throw new Error(`Feature ${feature.id} verification does not match its current definition`)
      if (!feature.verification.passed && feature.verification.featureDigest !== null) throw new Error(`Unverified feature ${feature.id} cannot retain a verification digest`)
      if (feature.status === "completed" && !feature.verification.passed) throw new Error(`Completed feature ${feature.id} requires passing verification evidence`)
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
  return plan
}

export function validateHorizonState(value: unknown, expectedSessionId?: string): HorizonState {
  if (!object(value) || value.schemaVersion !== PARALLAX_SCHEMA_VERSION) throw new Error("Invalid Horizon state schema")
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

function validateStateAgainstPlan(state: HorizonState, plan: HorizonPlan): void {
  const milestone = state.currentMilestoneId === null ? null : plan.milestones.find((item) => item.id === state.currentMilestoneId)
  if (state.currentMilestoneId !== null && !milestone) throw new Error(`State references unknown milestone ${state.currentMilestoneId}`)
  const featureMilestone = state.currentFeatureId === null ? null : plan.milestones.find((item) => item.features.some((feature) => feature.id === state.currentFeatureId))
  if (state.currentFeatureId !== null && !featureMilestone) throw new Error(`State references unknown feature ${state.currentFeatureId}`)
  if (milestone && featureMilestone && milestone.id !== featureMilestone.id) throw new Error("State current feature does not belong to its current milestone")
  if ((state.currentPhase === "complete") !== (plan.status === "completed")) throw new Error("Horizon state and plan completion phases do not match")
}

export function validateHorizonDecision(value: unknown): HorizonDecision {
  if (!object(value)) throw new Error("Decision must be an object")
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

function validateConfig(value: unknown): HorizonConfig {
  if (!object(value)) throw new Error("Horizon config must be an object")
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

export class HorizonStore {
  readonly root: string
  private lockDepth = 0
  constructor(root = process.env.PARALLAX_HORIZON_HOME || join(homedir(), ".parallax", "horizon")) {
    this.root = resolve(root)
    this.withLock(() => this.migrateLegacyStore())
  }

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
        validateStateAgainstPlan(states.get(id)!, plans.get(id)!)
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

  private sessionDir(sessionId: string): string {
    const sessions = resolve(this.root, "sessions")
    const path = resolve(sessions, assertSafeId("session ID", sessionId))
    if (!path.startsWith(`${sessions}/`) && !path.startsWith(`${sessions}\\`)) throw new Error("Horizon session path escapes root")
    return path
  }
  private path(sessionId: string, name: string): string { return join(this.sessionDir(sessionId), name) }

  loadConfig(): HorizonConfig {
    const value = readJson(join(this.root, "config.json"))
    return value === null ? { ...DEFAULT_HORIZON_CONFIG } : validateConfig(value)
  }
  saveConfig(config: HorizonConfig): void { this.withLock(() => atomicWriteJson(join(this.root, "config.json"), validateConfig(config))) }

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
    const value = readJson(this.path(sessionId, "plan.json"))
    return value === null ? null : validateHorizonPlan(value, sessionId)
  }
  writePlan(sessionId: string, value: unknown, allowVerificationChanges = false): HorizonPlan {
    return this.withLock(() => {
      if (!this.readState(sessionId)) throw new Error(`Horizon session not initialized: ${sessionId}`)
      const existing = this.readPlan(sessionId)
      const plan = validateHorizonPlan(value, sessionId)
      if (existing?.status === "completed" && JSON.stringify(existing) !== JSON.stringify(plan)) throw new Error("Completed Horizon plans are immutable; create a new feature revision or session")
      const cap = this.loadConfig().maxRetryCycles
      if (plan.milestones.some((milestone) => milestone.features.some((feature) => feature.maxAttempts > cap))) throw new Error(`Feature maxAttempts exceeds configured maxRetryCycles (${cap})`)
      const priorVerification = new Map(existing?.milestones.flatMap((milestone) => milestone.features.map((feature) => [feature.id, feature.verification] as const)) ?? [])
      const nextFeatureIds = new Set(plan.milestones.flatMap((milestone) => milestone.features.map((feature) => feature.id)))
      for (const [featureId, verification] of priorVerification) {
        if (verification.passed && !nextFeatureIds.has(featureId)) throw new Error(`Verified feature ${featureId} cannot be removed; add a new unverified revision instead`)
      }
      for (const feature of plan.milestones.flatMap((milestone) => milestone.features)) {
        const prior = priorVerification.get(feature.id)
        if (!allowVerificationChanges && prior && JSON.stringify(prior) !== JSON.stringify(feature.verification)) throw new Error(`Feature ${feature.id} verification may only be updated by horizon_evaluate_subagent`)
        const previousFeature = existing?.milestones.flatMap((milestone) => milestone.features).find((candidate) => candidate.id === feature.id)
        if (previousFeature?.status === "completed" && feature.status !== "completed") throw new Error(`Completed feature ${feature.id} cannot be downgraded`)
        if (!prior && (feature.verification.passed || feature.status === "completed")) throw new Error(`New feature ${feature.id} must begin unverified and incomplete`)
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
      return this.updateFeature(sessionId, featureId, { verification: { ...verification, featureDigest: verification.passed ? currentDigest : null } }, true)
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
    const value = readJson(this.path(sessionId, "state.json"))
    return value === null ? null : validateHorizonState(value, sessionId)
  }
  writeState(sessionId: string, value: unknown): HorizonState {
    return this.withLock(() => {
      const plan = this.readPlan(sessionId)
      if (!plan) throw new Error(`Horizon session not found: ${sessionId}`)
      const state = validateHorizonState(value, sessionId)
      validateStateAgainstPlan(state, plan)
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
  status(sessionId: string): { plan: HorizonPlan | null; state: HorizonState | null; decisions: HorizonDecision[]; research: { findings: string | null; sources: Record<string, string> }; skills: string[]; traces: string[] } {
    return { plan: this.readPlan(sessionId), state: this.readState(sessionId), decisions: this.readDecisions(sessionId), research: this.readResearch(sessionId), skills: this.listSkills(sessionId), traces: this.listTraces(sessionId) }
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
