import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { computeCoherenceScore } from "./score.js"
import {
  PARALLAX_SCHEMA_VERSION,
  type ParallaxTrace,
  type PhaseName,
  type ProjectType,
  type TraceMetrics,
  type VerificationRecord,
  type VerificationVerdict,
} from "./types.js"

const AGENT_VERSION = "0.2.0"
const SUPPORTED_AGENT_VERSIONS = new Set(["0.1.0", AGENT_VERSION])

export function createTrace(sessionId: string, project: string, projectType: ProjectType = null): ParallaxTrace {
  return {
    schemaVersion: PARALLAX_SCHEMA_VERSION,
    session: {
      id: sessionId,
      agent: "parallax",
      agentVersion: AGENT_VERSION,
      startedAt: new Date().toISOString(),
      endedAt: null,
      project: resolve(project),
      projectType,
    },
    phases: [],
    writes: [],
    verifications: [],
    metrics: null,
    coherenceScore: null,
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

const PHASES = new Set<PhaseName>(["ambiguity_check", "four_invariants", "verification_gate", "design_check", "mode_switch", "execution", "commit_decision", "summary"])
const PROJECT_TYPES = new Set(["cargo", "go", "node", "python", "dotnet", null])
const VERDICTS = new Set(["pass", "fail", "skipped", "unknown"])
const VERIFICATION_SOURCES = new Set(["manual", "automatic"])
const VERIFICATION_RECORD_KEYS = new Set([
  "schemaVersion", "id", "sessionId", "source", "startedAt", "command", "args", "cwd", "timeoutMs",
  "durationMs", "exitCode", "verdict", "changedFiles", "stdout", "stderr", "combined", "outputTruncated",
  "timedOut", "skipReason",
])
function timestamp(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) }
function finite(value: unknown, minimum = 0): value is number { return typeof value === "number" && Number.isFinite(value) && value >= minimum }
function integer(value: unknown, minimum = 0): value is number { return finite(value, minimum) && Number.isInteger(value) }

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function normalizedFiles(files: readonly string[]): string[] {
  const unique = new Set(files.map((file) => file.trim().replaceAll("\\", "/").replace(/^\.\//, "")).filter(Boolean))
  return [...unique].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

/** Returns a detached, deeply immutable canonical receipt after validating its evidence. */
export function validateVerificationRecord(value: unknown): VerificationRecord {
  if (!object(value) || Object.keys(value).length !== VERIFICATION_RECORD_KEYS.size
    || Object.keys(value).some((key) => !VERIFICATION_RECORD_KEYS.has(key))
    || value.schemaVersion !== 2 || typeof value.id !== "string" || !value.id
    || typeof value.sessionId !== "string" || !value.sessionId || !VERIFICATION_SOURCES.has(value.source as string)
    || !timestamp(value.startedAt) || (value.command !== null && (typeof value.command !== "string" || !value.command.trim()))
    || !strings(value.args) || typeof value.cwd !== "string" || !value.cwd || !integer(value.timeoutMs)
    || !finite(value.durationMs) || (value.exitCode !== null && !Number.isInteger(value.exitCode))
    || !VERDICTS.has(value.verdict as VerificationVerdict) || !strings(value.changedFiles)
    || typeof value.stdout !== "string" || typeof value.stderr !== "string" || typeof value.combined !== "string"
    || typeof value.outputTruncated !== "boolean" || typeof value.timedOut !== "boolean"
    || (value.skipReason !== null && typeof value.skipReason !== "string")) throw new Error("Invalid schema-v2 verification receipt")
  if (JSON.stringify(value.changedFiles) !== JSON.stringify(normalizedFiles(value.changedFiles))) throw new Error("Verification changedFiles are not normalized, unique, and ordered")
  const hasReason = typeof value.skipReason === "string" && Boolean(value.skipReason.trim())
  if (value.verdict === "pass" && (!value.command || value.exitCode !== 0 || value.timedOut || value.skipReason !== null)) throw new Error("Pass receipt has contradictory verdict and exitCode evidence")
  if (value.verdict === "fail" && (!value.command || value.exitCode === null || value.exitCode === 0 || value.timedOut || value.skipReason !== null)) throw new Error("Fail receipt has contradictory verdict and exitCode evidence")
  if (value.verdict === "skipped" && (value.command !== null || value.args.length > 0 || value.exitCode !== null || value.timedOut || !hasReason)) throw new Error("Skipped receipt has contradictory evidence")
  if (value.verdict === "unknown" && (!value.command || value.exitCode !== null || !hasReason)) throw new Error("Unknown receipt requires a command, null exitCode, and explicit reason")
  const canonical = {
    ...value,
    args: Object.freeze([...(value.args as string[])]),
    changedFiles: Object.freeze([...(value.changedFiles as string[])]),
  } as unknown as VerificationRecord
  return compatibilityAliases(canonical)
}

function compatibilityAliases(record: VerificationRecord): VerificationRecord {
  Object.defineProperties(record, {
    timestamp: { configurable: true, get: () => record.startedAt },
    files: { configurable: true, get: () => record.changedFiles },
  })
  return Object.freeze(record)
}

/** Explicitly upgrades persisted trace-v1 evidence without presenting indeterminate outcomes as pass/fail. */
export function migrateVerificationRecordV1(value: unknown, sessionId: string, cwd: string): VerificationRecord {
  if (!object(value) || typeof value.id !== "string" || !value.id || !timestamp(value.timestamp)
    || (value.command !== null && typeof value.command !== "string") || !strings(value.files)
    || !new Set(["pass", "fail", "skipped"]).has(value.verdict as string)
    || (value.exitCode !== null && !Number.isInteger(value.exitCode)) || !finite(value.durationMs)
    || typeof value.stdout !== "string" || typeof value.stderr !== "string") throw new Error("Invalid trace-v1 verification record")
  const indeterminate = /timed? out|timeout|cancel|abort|spawn|enoent/i.test(`${value.stdout}\n${value.stderr}`)
  let verdict = value.verdict as VerificationVerdict
  let timedOut = /timed? out|timeout/i.test(`${value.stdout}\n${value.stderr}`)
  let reason: string | null = null
  if (indeterminate && value.command) {
    verdict = "unknown"
    reason = `Migrated trace-v1 indeterminate result: ${(value.stderr || value.stdout).trim() || "reason unavailable"}`
  } else if (verdict === "skipped") {
    reason = value.stderr.trim() || "Migrated trace-v1 record did not include a skip reason."
  }
  const coherentPass = verdict === "pass" && Boolean(value.command) && value.exitCode === 0
  const coherentFail = verdict === "fail" && Boolean(value.command) && typeof value.exitCode === "number" && value.exitCode !== 0
  if (!coherentPass && !coherentFail && verdict !== "skipped" && verdict !== "unknown") {
    verdict = "unknown"
    reason = "Migrated trace-v1 record contained contradictory verdict evidence."
  }
  return validateVerificationRecord({
    schemaVersion: 2, id: value.id, sessionId, source: "automatic", startedAt: value.timestamp,
    command: value.command, args: [], cwd, timeoutMs: 0, durationMs: value.durationMs, exitCode: verdict === "unknown" ? null : value.exitCode,
    verdict, changedFiles: normalizedFiles(value.files), stdout: value.stdout, stderr: value.stderr,
    combined: [value.stdout, value.stderr].filter(Boolean).join("\n"), outputTruncated: false, timedOut, skipReason: reason,
  })
}

/** Rejects every malformed or foreign nested trace field instead of trusting a cast. */
export function validateTrace(value: unknown, expectedSessionId?: string, expectedMaxRetries?: number): ParallaxTrace {
  if (!object(value) || value.schemaVersion !== PARALLAX_SCHEMA_VERSION) throw new Error("Invalid trace schema")
  const session = value.session
  if (!object(session) || typeof session.id !== "string" || !session.id) throw new Error("Invalid trace session")
  if (expectedSessionId !== undefined && session.id !== expectedSessionId) throw new Error("Trace belongs to a different session")
  if (session.agent !== "parallax" || !SUPPORTED_AGENT_VERSIONS.has(session.agentVersion as string) || !timestamp(session.startedAt)
    || (session.endedAt !== null && !timestamp(session.endedAt)) || typeof session.project !== "string" || !session.project
    || !PROJECT_TYPES.has(session.projectType as ProjectType)) throw new Error("Invalid trace metadata")
  if (typeof session.endedAt === "string" && Date.parse(session.endedAt) < Date.parse(session.startedAt)) throw new Error("Trace endedAt precedes startedAt")
  if (!Array.isArray(value.phases) || !Array.isArray(value.writes) || !Array.isArray(value.verifications)) throw new Error("Invalid trace records")
  for (const phase of value.phases) {
    if (!object(phase) || !PHASES.has(phase.phase as PhaseName) || !timestamp(phase.timestamp) || !object(phase.data)) throw new Error("Invalid phase record")
  }
  for (const write of value.writes) {
    if (!object(write) || typeof write.batchId !== "string" || !write.batchId || typeof write.file !== "string" || !write.file
      || typeof write.tool !== "string" || !write.tool || !timestamp(write.timestamp)
      || (write.verificationId !== null && typeof write.verificationId !== "string")
      || !new Set<unknown>(["pass", "fail", "skipped", "unknown"]).has(write.verification)
      || !integer(write.frictionRetriesLeft)) throw new Error("Invalid write record")
  }
  const verificationIds = new Set<string>()
  const verificationById = new Map<string, VerificationRecord>()
  for (let index = 0; index < value.verifications.length; index += 1) {
    const candidate = value.verifications[index]
    const verification = object(candidate) && candidate.schemaVersion === 2
      ? validateVerificationRecord(candidate)
      : migrateVerificationRecordV1(candidate, session.id as string, session.project as string)
    value.verifications[index] = verification
    if (verificationIds.has(verification.id)) throw new Error("Duplicate verification receipt ID")
    verificationIds.add(verification.id)
    verificationById.set(verification.id, verification)
  }
  const batches = new Map<string, { verificationId: unknown; verification: unknown; timestamp: unknown; tool: unknown; frictionRetriesLeft: unknown }>()
  for (const write of value.writes) {
    if (write.verificationId !== null && !verificationIds.has(write.verificationId as string)) throw new Error("Write references missing verification")
    if ((write.verification === "unknown") !== (write.verificationId === null)) throw new Error("Write verification reference is inconsistent")
    if (write.verificationId !== null && verificationById.get(write.verificationId as string)?.verdict !== write.verification) {
      throw new Error("Write verdict does not match its verification record")
    }
    const signature = { verificationId: write.verificationId, verification: write.verification, timestamp: write.timestamp, tool: write.tool, frictionRetriesLeft: write.frictionRetriesLeft }
    const prior = batches.get(write.batchId as string)
    if (prior && JSON.stringify(prior) !== JSON.stringify(signature)) throw new Error("Write batch records are internally inconsistent")
    batches.set(write.batchId as string, signature)
  }
  if (value.metrics !== null) {
    const metrics = value.metrics
    if (object(metrics)) {
      // Same-schema compatibility for checkpoints written before audit-derived fields were added.
      if (metrics.maxRetries === undefined) metrics.maxRetries = expectedMaxRetries ?? 3
      if (metrics.computedAt === undefined && integer(metrics.durationSeconds)) {
        metrics.computedAt = session.endedAt ?? new Date(Date.parse(session.startedAt) + metrics.durationSeconds * 1_000).toISOString()
      }
    }
    if (!object(metrics) || !integer(metrics.maxRetries, 1) || !timestamp(metrics.computedAt) || !integer(metrics.durationSeconds) || !integer(metrics.totalPhases) || !integer(metrics.totalWrites)
      || !finite(metrics.verificationPassRate) || metrics.verificationPassRate > 1
      || !finite(metrics.firstAttemptPassRate) || metrics.firstAttemptPassRate > 1
      || !integer(metrics.totalFrictionRetries) || !integer(metrics.protocolStepsCompleted) || metrics.protocolStepsCompleted > 5
      || metrics.totalPhases !== value.phases.length || metrics.totalWrites !== value.writes.length) throw new Error("Invalid trace metrics")
    if (Date.parse(metrics.computedAt) < Date.parse(session.startedAt) || Date.parse(metrics.computedAt) > Date.now() + 5_000) throw new Error("Trace metrics computedAt is outside the session timeline")
    if (session.endedAt !== null && metrics.computedAt !== session.endedAt) throw new Error("Final trace metrics must be computed at endedAt")
    if (expectedMaxRetries !== undefined && metrics.maxRetries !== expectedMaxRetries) throw new Error("Trace metrics maxRetries does not match session friction policy")
    const expected = computeMetrics(value as unknown as ParallaxTrace, metrics.maxRetries, metrics.computedAt)
    if (metrics.durationSeconds !== expected.durationSeconds
      || metrics.verificationPassRate !== expected.verificationPassRate
      || metrics.firstAttemptPassRate !== expected.firstAttemptPassRate
      || metrics.totalFrictionRetries !== expected.totalFrictionRetries
      || metrics.protocolStepsCompleted !== expected.protocolStepsCompleted) throw new Error("Trace metrics do not match trace records")
  }
  if (value.coherenceScore !== null) {
    if (!finite(value.coherenceScore) || value.coherenceScore > 100) throw new Error("Invalid trace coherenceScore")
    if (value.coherenceScore !== computeCoherenceScore(value as unknown as ParallaxTrace).total) throw new Error("Trace coherenceScore does not match trace records")
  }
  return value as unknown as ParallaxTrace
}

export function invalidateTrace(trace: ParallaxTrace): void {
  trace.metrics = null
  trace.coherenceScore = null
}

export function addPhase(trace: ParallaxTrace, phase: PhaseName, data: Record<string, unknown> = {}): void {
  invalidateTrace(trace)
  trace.phases.push({ phase, timestamp: new Date().toISOString(), data })
}

/** Records every file in a multi-file tool call; no mutation is collapsed or lost. */
export function addWriteBatch(
  trace: ParallaxTrace,
  files: readonly string[],
  tool: string,
  verification: VerificationRecord | null,
  frictionRetriesLeft: number,
  batchId: string = randomUUID(),
): string {
  invalidateTrace(trace)
  const uniqueFiles = [...new Set(files.map((file) => file.trim()).filter(Boolean))]
  const timestamp = new Date().toISOString()
  for (const file of uniqueFiles) {
    trace.writes.push({
      batchId,
      file,
      tool,
      timestamp,
      verificationId: verification?.id ?? null,
      verification: verification?.verdict ?? "unknown",
      frictionRetriesLeft,
    })
  }
  if (verification && !trace.verifications.some((record) => record.id === verification.id)) {
    trace.verifications.push(verification)
  }
  return batchId
}

export function computeMetrics(trace: ParallaxTrace, maxRetries = 3, computedAt = new Date().toISOString()): TraceMetrics {
  const known = trace.verifications.filter((record) => record.verdict !== "skipped")
  const passes = known.filter((record) => record.verdict === "pass").length
  const batches = new Map<string, (typeof trace.writes)[number]>()
  for (const write of trace.writes) if (!batches.has(write.batchId)) batches.set(write.batchId, write)
  const firstPass = [...batches.values()].filter((write) => write.verification === "pass" && write.frictionRetriesLeft >= maxRetries).length
  const required: PhaseName[] = ["ambiguity_check", "four_invariants", "verification_gate", "commit_decision", "summary"]
  const completed = new Set(trace.phases.filter((phase) => required.includes(phase.phase)).map((phase) => phase.phase))
  return {
    maxRetries,
    computedAt,
    durationSeconds: Math.max(0, Math.round((Date.parse(computedAt) - Date.parse(trace.session.startedAt)) / 1000)),
    totalPhases: trace.phases.length,
    totalWrites: trace.writes.length,
    verificationPassRate: known.length ? passes / known.length : 0,
    firstAttemptPassRate: batches.size ? firstPass / batches.size : 0,
    totalFrictionRetries: trace.verifications.filter((record) => record.verdict === "fail").length,
    protocolStepsCompleted: completed.size,
  }
}

export function checkpointTrace(trace: ParallaxTrace, maxRetries = 3): ParallaxTrace {
  trace.metrics = computeMetrics(trace, maxRetries)
  trace.coherenceScore = computeCoherenceScore(trace).total
  return trace
}

export function finalizeTrace(trace: ParallaxTrace, maxRetries = 3): ParallaxTrace {
  const endedAt = new Date().toISOString()
  trace.session.endedAt = endedAt
  trace.metrics = computeMetrics(trace, maxRetries, endedAt)
  trace.coherenceScore = computeCoherenceScore(trace).total
  return trace
}

export function exportTrace(trace: ParallaxTrace, projectRoot = trace.session.project): string {
  validateTrace(trace, trace.session.id)
  const directory = join(projectRoot, ".parallax", "traces")
  const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trace.session.id)
    ? trace.session.id
    : `session-${createHash("sha256").update(trace.session.id).digest("hex").slice(0, 32)}`
  const path = join(directory, `${safeId}.json`)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return path
}

export function loadTrace(path: string, expectedSessionId?: string): ParallaxTrace {
  return validateTrace(JSON.parse(readFileSync(path, "utf8")), expectedSessionId)
}

type VerificationInput = Omit<VerificationRecord, "schemaVersion" | "id" | "startedAt" | "timestamp" | "files">
type LegacyVerificationInput = {
  command: string | null; files: readonly string[]; verdict: Exclude<VerificationVerdict, "unknown">; exitCode: number | null
  durationMs: number; stdout: string; stderr: string
}

export function createVerificationRecord(input: VerificationInput, identity?: { id?: string; startedAt?: string }): VerificationRecord
export function createVerificationRecord(input: LegacyVerificationInput, identity?: { id?: string; startedAt?: string }): VerificationRecord
export function createVerificationRecord(input: VerificationInput | LegacyVerificationInput, identity: { id?: string; startedAt?: string } = {}): VerificationRecord {
  if ("files" in input) {
    return migrateVerificationRecordV1({ id: identity.id ?? randomUUID(), timestamp: identity.startedAt ?? new Date().toISOString(), ...input }, "legacy-api", process.cwd())
  }
  return validateVerificationRecord({ schemaVersion: 2, id: identity.id ?? randomUUID(), startedAt: identity.startedAt ?? new Date().toISOString(), ...input })
}

export function verdictForExitCode(exitCode: number | null): VerificationVerdict {
  return exitCode === null ? "unknown" : exitCode === 0 ? "pass" : "fail"
}
