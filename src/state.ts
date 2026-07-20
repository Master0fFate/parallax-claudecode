import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { withDirectoryLock } from "./lock.js"
import { PARALLAX_SCHEMA_VERSION, type ProtocolStep, type SessionState } from "./types.js"
import { createTrace, validateTrace } from "./trace.js"

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STEPS: ProtocolStep[] = ["ambiguity", "invariants", "gate", "design", "commit", "summary"]

export function sessionStorageKey(sessionId: string): string {
  if (!sessionId) throw new Error("Session ID is required")
  return SAFE_ID.test(sessionId)
    ? sessionId
    : `session-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`
}

export function createSessionState(sessionId: string, cwd: string, maxRetries = 3): SessionState {
  if (!Number.isInteger(maxRetries) || maxRetries < 1 || maxRetries > 100) throw new Error("maxRetries must be an integer from 1 to 100")
  const completed = Object.fromEntries(STEPS.map((step) => [step, false])) as Record<ProtocolStep, boolean>
  return {
    schemaVersion: PARALLAX_SCHEMA_VERSION,
    sessionId,
    cwd: resolve(cwd),
    mode: "build",
    protocol: { epoch: 1, startedWriteCount: 0, completed, evidence: {} },
    friction: {
      successes: 0,
      trials: 0,
      consecutiveFailures: 0,
      maxRetries,
      retriesLeft: maxRetries,
      recoveryAttempts: 0,
      repairWritesRemaining: 0,
      lastObservation: null,
    },
    trace: createTrace(sessionId, resolve(cwd)),
    updatedAt: new Date().toISOString(),
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function validateSessionState(value: unknown, expectedSessionId?: string): SessionState {
  if (!isObject(value)) throw new Error("Session state must be an object")
  if (value.schemaVersion !== PARALLAX_SCHEMA_VERSION) throw new Error("Unsupported session state schemaVersion")
  if (typeof value.sessionId !== "string" || !value.sessionId) throw new Error("Session state sessionId is required")
  if (expectedSessionId !== undefined && value.sessionId !== expectedSessionId) throw new Error("Session state belongs to a different session")
  if (typeof value.cwd !== "string" || typeof value.updatedAt !== "string") throw new Error("Session state cwd and updatedAt are required")
  if (!["free", "plan", "build", "debug", "horizon"].includes(String(value.mode))) throw new Error("Invalid session mode")
  if (!isObject(value.protocol) || !isObject(value.protocol.completed) || !isObject(value.protocol.evidence)) throw new Error("Invalid protocol state")
  // In-place compatibility upgrade for pre-audit 1.0 session files. The next locked
  // mutation persists these fields; prior writes intentionally force a fresh epoch.
  if (value.protocol.epoch === undefined) value.protocol.epoch = 1
  if (value.protocol.startedWriteCount === undefined) value.protocol.startedWriteCount = 0
  for (const key of ["epoch", "startedWriteCount"] as const) {
    const item = value.protocol[key]
    if (typeof item !== "number" || !Number.isInteger(item) || item < (key === "epoch" ? 1 : 0)) throw new Error(`Invalid protocol ${key}`)
  }
  for (const step of STEPS) {
    if (typeof value.protocol.completed[step] !== "boolean") throw new Error(`Invalid protocol step: ${step}`)
    const evidence = value.protocol.evidence[step]
    if (evidence !== undefined && typeof evidence !== "string") throw new Error(`Invalid protocol evidence: ${step}`)
  }
  if (!isObject(value.friction)) throw new Error("Invalid friction state")
  if (value.friction.maxRetries === undefined) value.friction.maxRetries = Math.max(3, Number(value.friction.retriesLeft) || 0)
  if (value.friction.recoveryAttempts === undefined) value.friction.recoveryAttempts = 0
  if (value.friction.repairWritesRemaining === undefined) value.friction.repairWritesRemaining = 0
  for (const key of ["successes", "trials", "consecutiveFailures", "maxRetries", "retriesLeft", "recoveryAttempts", "repairWritesRemaining"] as const) {
    const item = value.friction[key]
    if (typeof item !== "number" || !Number.isInteger(item) || item < (key === "maxRetries" ? 1 : 0)) throw new Error(`Invalid friction ${key}`)
  }
  if (Number(value.friction.retriesLeft) > Number(value.friction.maxRetries)) throw new Error("Invalid friction retriesLeft")
  if (Number(value.friction.repairWritesRemaining) > 1) throw new Error("Invalid friction repairWritesRemaining")
  if (value.friction.lastObservation !== null && typeof value.friction.lastObservation !== "string") throw new Error("Invalid lastObservation")
  validateTrace(value.trace, value.sessionId, value.friction.maxRetries as number)
  return value as unknown as SessionState
}

export function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporary, "wx", 0o600)
    writeFileSync(descriptor, content, "utf8")
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, path)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    rmSync(temporary, { force: true })
    throw error
  }
}

export function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`)
}

function canonicalRoot(path: string): string {
  try { return resolve(realpathSync.native(resolve(path))) }
  catch (error) { throw new Error(`Parallax project root must exist and be canonicalizable: ${resolve(path)} (${error instanceof Error ? error.message : String(error)})`) }
}

export class SessionStore {
  readonly projectRoot: string
  readonly root: string

  constructor(projectRoot: string) {
    this.projectRoot = canonicalRoot(projectRoot)
    this.root = join(this.projectRoot, ".parallax", "sessions")
  }

  pathFor(sessionId: string): string {
    return join(this.root, sessionStorageKey(sessionId), "state.json")
  }

  read(sessionId: string): SessionState | null {
    const path = this.pathFor(sessionId)
    try {
      const state = validateSessionState(JSON.parse(readFileSync(path, "utf8")), sessionId)
      if (canonicalRoot(state.cwd) !== this.projectRoot || canonicalRoot(state.trace.session.project) !== this.projectRoot) {
        throw new Error(`Session state project root does not match its canonical store root: ${this.projectRoot}`)
      }
      return state
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    }
  }

  initialize(sessionId: string, _cwd: string, maxRetries = 3): SessionState {
    return this.update(sessionId, (current) => current ?? createSessionState(sessionId, this.projectRoot, maxRetries))
  }

  private writeUnlocked(sessionId: string, state: SessionState): void {
    validateSessionState(state, sessionId)
    if (canonicalRoot(state.cwd) !== this.projectRoot || canonicalRoot(state.trace.session.project) !== this.projectRoot) {
      throw new Error(`Session state project root does not match its canonical store root: ${this.projectRoot}`)
    }
    state.updatedAt = new Date().toISOString()
    atomicWriteJson(this.pathFor(sessionId), state)
  }

  /** Persist a replacement under the same per-session lock used by updates. */
  write(sessionId: string, state: SessionState): void {
    this.withLock(sessionId, () => this.writeUnlocked(sessionId, state))
  }

  update(sessionId: string, updater: (state: SessionState | null) => SessionState): SessionState {
    return this.withLock(sessionId, () => {
      const next = updater(this.read(sessionId))
      this.writeUnlocked(sessionId, next)
      return next
    })
  }

  /** Run finalization/export and any associated state write as one locked transaction. */
  finalize<T>(sessionId: string, finalizer: (state: SessionState) => T): T | null {
    return this.withLock(sessionId, () => {
      const state = this.read(sessionId)
      if (!state) return null
      const result = finalizer(state)
      this.writeUnlocked(sessionId, state)
      return result
    })
  }

  remove(sessionId: string): void {
    this.withLock(sessionId, () => rmSync(dirname(this.pathFor(sessionId)), { recursive: true, force: true }))
  }

  private withLock<T>(sessionId: string, operation: () => T): T {
    const lock = join(this.root, `${sessionStorageKey(sessionId)}.lock`)
    return withDirectoryLock(lock, operation, { label: `Parallax session ${sessionId}` })
  }
}
