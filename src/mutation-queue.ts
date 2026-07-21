import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { readFileSync, realpathSync } from "node:fs"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { withDirectoryLock } from "./lock.js"
import { atomicWriteJson, sessionStorageKey } from "./state.js"
import { validateVerificationRecord } from "./trace.js"
import type { VerificationRecord } from "./types.js"

const QUEUE_SCHEMA_VERSION = 1 as const
const DEFAULT_LEASE_MS = 150_000

export interface MutationIntent {
  toolUseId: string
  tool: string
  fingerprint: string
  targets: string[]
  createdAt: string
}

export interface MutationObservation {
  toolUseId: string
  tool: string | null
  fingerprint: string | null
  outcome: "success" | "failure" | "unknown"
  detail: string
}

export interface MutationReconciliation {
  observedAt: string
  reason: string
  toolUseIds: string[]
}

export interface MutationClaim {
  id: string
  owner: { pid: number; host: string; token: string }
  claimedAt: string
  leaseUntil: string
  intents: MutationIntent[]
  receipt: VerificationRecord | null
}

export interface MutationQueueState {
  schemaVersion: typeof QUEUE_SCHEMA_VERSION
  projectRoot: string
  sessionId: string
  pending: MutationIntent[]
  active: MutationClaim | null
  unresolved: MutationReconciliation | null
  updatedAt: string
}

export type ClaimResult =
  | { status: "empty" }
  | { status: "busy"; leaseUntil: string }
  | { status: "claimed"; claim: MutationClaim; recovered: boolean }

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function canonicalRoot(path: string): string {
  return resolve(realpathSync.native(resolve(path)))
}

function contained(root: string, path: string): boolean {
  const child = relative(root, path)
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function validateIntent(value: unknown): MutationIntent {
  if (!object(value) || typeof value.toolUseId !== "string" || !value.toolUseId
    || typeof value.tool !== "string" || !value.tool || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !Array.isArray(value.targets)
    || !value.targets.length || !value.targets.every((target) => typeof target === "string" && target.length > 0)
    || !validTimestamp(value.createdAt)) throw new Error("Invalid durable mutation intent")
  return value as unknown as MutationIntent
}

function validateClaim(value: unknown): MutationClaim {
  if (!object(value) || typeof value.id !== "string" || !value.id || !object(value.owner)
    || !Number.isInteger(value.owner.pid) || Number(value.owner.pid) < 1
    || typeof value.owner.host !== "string" || !value.owner.host
    || typeof value.owner.token !== "string" || !value.owner.token
    || !validTimestamp(value.claimedAt) || !validTimestamp(value.leaseUntil)
    || !Array.isArray(value.intents) || !value.intents.length) throw new Error("Invalid durable mutation claim")
  value.intents.forEach(validateIntent)
  if (value.receipt !== null) value.receipt = validateVerificationRecord(value.receipt)
  return value as unknown as MutationClaim
}

export function validateMutationQueueState(value: unknown, projectRoot?: string, sessionId?: string): MutationQueueState {
  if (!object(value) || value.schemaVersion !== QUEUE_SCHEMA_VERSION
    || (projectRoot !== undefined && value.projectRoot !== projectRoot)
    || (sessionId !== undefined && value.sessionId !== sessionId) || typeof value.projectRoot !== "string" || !value.projectRoot
    || typeof value.sessionId !== "string" || !value.sessionId || !Array.isArray(value.pending)
    || (value.active !== null && !object(value.active)) || (value.unresolved !== null && !object(value.unresolved))
    || !validTimestamp(value.updatedAt)) {
    throw new Error("Invalid durable mutation queue")
  }
  value.pending.forEach(validateIntent)
  if (value.active !== null) validateClaim(value.active)
  if (value.unresolved !== null && (!validTimestamp(value.unresolved.observedAt)
    || typeof value.unresolved.reason !== "string" || !value.unresolved.reason
    || !Array.isArray(value.unresolved.toolUseIds)
    || !value.unresolved.toolUseIds.every((id) => typeof id === "string" && id))) throw new Error("Invalid mutation reconciliation state")
  const ids = [...value.pending, ...(value.active ? (value.active as unknown as MutationClaim).intents : [])].map((intent) => (intent as MutationIntent).toolUseId)
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate durable mutation intent ID")
  return value as unknown as MutationQueueState
}

function ownerAlive(claim: MutationClaim): boolean | null {
  if (claim.owner.host !== hostname()) return null
  try { process.kill(claim.owner.pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" ? true : false }
}

/** Durable per-project/session mutation queue. Storage names never derive directly from tool input. */
export class MutationIntentQueue {
  readonly projectRoot: string
  readonly root: string
  readonly path: string
  readonly lockPath: string
  private readonly sessionId: string
  private readonly leaseMs: number
  private readonly now: () => number

  constructor(projectRoot: string, sessionId: string, options: { leaseMs?: number; now?: () => number } = {}) {
    this.projectRoot = canonicalRoot(projectRoot)
    this.sessionId = sessionId
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.now = options.now ?? Date.now
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1) throw new Error("Mutation claim lease must be a positive integer")
    this.root = resolve(this.projectRoot, ".parallax", "mutation-intents")
    const key = sessionStorageKey(sessionId)
    this.path = resolve(this.root, key, "queue.json")
    this.lockPath = resolve(this.root, `${key}.lock`)
    if (!contained(this.root, this.path) || !contained(this.root, this.lockPath)) throw new Error("Mutation queue path escaped its storage root")
  }

  private initial(): MutationQueueState {
    return { schemaVersion: QUEUE_SCHEMA_VERSION, projectRoot: this.projectRoot, sessionId: this.sessionId, pending: [], active: null, unresolved: null, updatedAt: new Date(this.now()).toISOString() }
  }

  private readUnlocked(): MutationQueueState {
    try { return validateMutationQueueState(JSON.parse(readFileSync(this.path, "utf8")), this.projectRoot, this.sessionId) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.initial()
      throw error
    }
  }

  read(): Readonly<MutationQueueState> {
    return this.readUnlocked()
  }

  private writeUnlocked(state: MutationQueueState): void {
    state.updatedAt = new Date(this.now()).toISOString()
    validateMutationQueueState(state, this.projectRoot, this.sessionId)
    atomicWriteJson(this.path, state)
  }

  private locked<T>(operation: () => T): T {
    return withDirectoryLock(this.lockPath, operation, { label: `Parallax mutation queue ${this.sessionId}` })
  }

  record(intent: Omit<MutationIntent, "createdAt">): MutationIntent {
    const candidate = validateIntent({ ...intent, createdAt: new Date(this.now()).toISOString() })
    return this.locked(() => {
      const state = this.readUnlocked()
      if (state.active) throw new Error(`mutation verification claim ${state.active.id} is still active`)
      if (state.unresolved) throw new Error(`mutation intent reconciliation required: ${state.unresolved.reason}`)
      const existing = state.pending.find((item) => item.toolUseId === candidate.toolUseId)
      if (existing) {
        if (existing.tool !== candidate.tool || existing.fingerprint !== candidate.fingerprint || JSON.stringify(existing.targets) !== JSON.stringify(candidate.targets)) {
          throw new Error(`Mutation intent ID collision: ${candidate.toolUseId}`)
        }
        return existing
      }
      state.pending.push(candidate)
      this.writeUnlocked(state)
      return candidate
    })
  }

  observe(observations: readonly MutationObservation[], malformedReason: string | null = null): ClaimResult {
    return this.locked(() => {
      const state = this.readUnlocked()
      const active = state.active
      if (active) {
        const expired = Date.parse(active.leaseUntil) <= this.now()
        const alive = ownerAlive(active)
        // Unknown remote-host liveness gets an additional full lease before conservative takeover.
        const remoteGraceElapsed = this.now() >= Date.parse(active.leaseUntil) + this.leaseMs
        if (!expired || alive === true || (alive === null && !remoteGraceElapsed)) {
          this.writeUnlocked(state)
          return { status: "busy", leaseUntil: active.leaseUntil }
        }
        active.owner = { pid: process.pid, host: hostname(), token: randomUUID() }
        active.leaseUntil = new Date(this.now() + this.leaseMs).toISOString()
        this.writeUnlocked(state)
        return { status: "claimed", claim: active, recovered: true }
      }

      const byId = new Map(observations.map((observation) => [observation.toolUseId, observation]))
      const unresolved = new Set<string>()
      const failures = new Set<string>()
      const successes = new Set<string>()
      for (const intent of state.pending) {
        if (malformedReason) { unresolved.add(intent.toolUseId); continue }
        const observation = byId.get(intent.toolUseId)
        if (!observation) {
          if (malformedReason || observations.length) unresolved.add(intent.toolUseId)
          continue
        }
        if (observation.tool !== intent.tool || observation.fingerprint !== intent.fingerprint) {
          unresolved.add(intent.toolUseId)
          continue
        }
        if (observation.outcome === "success") successes.add(intent.toolUseId)
        else if (observation.outcome === "failure") failures.add(intent.toolUseId)
        else unresolved.add(intent.toolUseId)
      }
      state.pending = state.pending.filter((intent) => !failures.has(intent.toolUseId))
      if (unresolved.size) {
        const details = observations.filter((item) => unresolved.has(item.toolUseId)).map((item) => item.detail)
        state.unresolved = {
          observedAt: new Date(this.now()).toISOString(),
          reason: malformedReason ?? details[0] ?? "PostToolBatch did not contain matching evidence for every durable intent",
          toolUseIds: [...unresolved],
        }
      } else state.unresolved = null
      const intents = state.pending.filter((intent) => successes.has(intent.toolUseId))
      if (!intents.length) {
        this.writeUnlocked(state)
        return { status: "empty" }
      }
      const selected = new Set(intents.map((intent) => intent.toolUseId))
      state.pending = state.pending.filter((intent) => !selected.has(intent.toolUseId))
      const claimedAt = new Date(this.now()).toISOString()
      const claim: MutationClaim = {
        id: randomUUID(), owner: { pid: process.pid, host: hostname(), token: randomUUID() }, claimedAt,
        leaseUntil: new Date(this.now() + this.leaseMs).toISOString(), intents, receipt: null,
      }
      state.active = claim
      this.writeUnlocked(state)
      return { status: "claimed", claim, recovered: false }
    })
  }

  /** Persist an unevidenced batch without discarding pending intents or an in-flight claim. */
  rejectEvidence(reason: string): Readonly<MutationQueueState> {
    return this.locked(() => {
      const state = this.readUnlocked()
      const toolUseIds = [
        ...state.pending.map((intent) => intent.toolUseId),
        ...(state.active?.intents.map((intent) => intent.toolUseId) ?? []),
      ]
      if (toolUseIds.length) {
        state.unresolved = {
          observedAt: new Date(this.now()).toISOString(),
          reason,
          toolUseIds,
        }
        this.writeUnlocked(state)
      }
      return state
    })
  }

  /** Lifecycle boundaries turn otherwise unevidenced pending intents into an explicit write block. */
  reconcileBoundary(reason: string): Readonly<MutationQueueState> {
    return this.locked(() => {
      const state = this.readUnlocked()
      if (state.pending.length && !state.unresolved) {
        state.unresolved = {
          observedAt: new Date(this.now()).toISOString(), reason,
          toolUseIds: state.pending.map((intent) => intent.toolUseId),
        }
        this.writeUnlocked(state)
      }
      return state
    })
  }

  attachReceipt(claimId: string, receipt: VerificationRecord): void {
    this.locked(() => {
      const state = this.readUnlocked()
      if (state.active?.id !== claimId) throw new Error(`Mutation claim is no longer active: ${claimId}`)
      if (receipt.id !== claimId) throw new Error("Verification receipt ID must equal its mutation claim ID")
      state.active.receipt = validateVerificationRecord(receipt)
      this.writeUnlocked(state)
    })
  }

  complete(claimId: string): void {
    this.locked(() => {
      const state = this.readUnlocked()
      if (state.active?.id !== claimId) throw new Error(`Mutation claim is no longer active: ${claimId}`)
      if (!state.active.receipt) throw new Error("Cannot complete a mutation claim without durable verification evidence")
      const completedIds = new Set(state.active.intents.map((intent) => intent.toolUseId))
      state.active = null
      if (state.unresolved) {
        state.unresolved.toolUseIds = state.unresolved.toolUseIds.filter((id) => !completedIds.has(id))
        if (!state.unresolved.toolUseIds.length) state.unresolved = null
      }
      this.writeUnlocked(state)
    })
  }
}
