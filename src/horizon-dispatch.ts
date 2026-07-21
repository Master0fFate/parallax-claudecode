import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { withDirectoryLock } from "./lock.js"
import { atomicWriteJson } from "./state.js"

export type HorizonDispatchRole = "worker" | "auditor"

export interface HorizonPendingDispatch {
  schemaVersion: 2
  parentSessionId: string
  horizonSessionId: string
  featureId: string
  role: HorizonDispatchRole
  toolUseId: string
  agentId: string | null
  status: "pending" | "bound" | "quarantined" | "completed"
  stopObserved: boolean
  agentCompleted: boolean
  quarantineReason: string | null
  createdAt: string
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function safe(value: string, label: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}`)
  return value
}

function validate(value: unknown, parentSessionId: string): HorizonPendingDispatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Horizon pending dispatch")
  const item = value as Record<string, unknown>
  const keys = ["schemaVersion", "parentSessionId", "horizonSessionId", "featureId", "role", "toolUseId", "agentId", "status", "stopObserved", "agentCompleted", "quarantineReason", "createdAt"]
  if (Object.keys(item).some((key) => !keys.includes(key)) || item.schemaVersion !== 2 || item.parentSessionId !== parentSessionId) throw new Error("Invalid Horizon pending dispatch identity")
  if (item.role !== "worker" && item.role !== "auditor" || !["pending", "bound", "quarantined", "completed"].includes(String(item.status))) throw new Error("Invalid Horizon pending dispatch stage")
  if (item.agentId !== null && typeof item.agentId !== "string") throw new Error("Invalid Horizon pending dispatch agent ID")
  if (typeof item.stopObserved !== "boolean" || typeof item.agentCompleted !== "boolean" || item.quarantineReason !== null && typeof item.quarantineReason !== "string") throw new Error("Invalid Horizon pending dispatch lifecycle evidence")
  if (item.status === "completed" && (!item.stopObserved || !item.agentCompleted || item.quarantineReason !== null)) throw new Error("Completed Horizon dispatch lacks dual lifecycle evidence")
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) throw new Error("Invalid Horizon pending dispatch timestamp")
  return {
    schemaVersion: 2, parentSessionId, horizonSessionId: safe(String(item.horizonSessionId), "Horizon session ID"),
    featureId: safe(String(item.featureId), "feature ID"), role: item.role, toolUseId: safe(String(item.toolUseId), "tool use ID"),
    agentId: item.agentId === null ? null : safe(item.agentId, "agent ID"), status: item.status as HorizonPendingDispatch["status"],
    stopObserved: item.stopObserved, agentCompleted: item.agentCompleted, quarantineReason: item.quarantineReason as string | null, createdAt: item.createdAt,
  }
}

export class HorizonDispatchStore {
  readonly root: string
  constructor(projectRoot: string) { this.root = resolve(projectRoot, ".parallax", "horizon-dispatch") }
  private path(parentSessionId: string): string { return join(this.root, `${safe(parentSessionId, "parent session ID")}.json`) }
  private locked<T>(operation: () => T): T { return withDirectoryLock(join(this.root, ".lock"), operation, { timeoutMs: 10_000, label: "Horizon dispatch" }) }
  read(parentSessionId: string): HorizonPendingDispatch | null {
    try { return validate(JSON.parse(readFileSync(this.path(parentSessionId), "utf8")) as unknown, parentSessionId) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error }
  }
  requireCompleted(parentSessionId: string, expected: { horizonSessionId: string; featureId: string; role: HorizonDispatchRole; childRunId: string }): HorizonPendingDispatch {
    const item = this.read(parentSessionId)
    if (!item || item.horizonSessionId !== expected.horizonSessionId || item.featureId !== expected.featureId || item.role !== expected.role
      || item.agentId !== expected.childRunId || item.status !== "completed" || !item.stopObserved || !item.agentCompleted) {
      throw new Error(`Horizon ${expected.role} transition requires the exact matching completed dual-lifecycle dispatch`)
    }
    return item
  }
  acquire(value: Omit<HorizonPendingDispatch, "schemaVersion" | "agentId" | "status" | "stopObserved" | "agentCompleted" | "quarantineReason" | "createdAt">): HorizonPendingDispatch {
    return this.locked(() => {
      if (this.read(value.parentSessionId)) throw new Error("Another Horizon dispatch is already pending")
      const item: HorizonPendingDispatch = { schemaVersion: 2, ...value, agentId: null, status: "pending", stopObserved: false, agentCompleted: false, quarantineReason: null, createdAt: new Date().toISOString() }
      mkdirSync(this.root, { recursive: true }); atomicWriteJson(this.path(value.parentSessionId), item); return item
    })
  }
  bind(parentSessionId: string, agentId: string): HorizonPendingDispatch {
    return this.locked(() => { const item = this.read(parentSessionId); if (!item || item.status !== "pending") throw new Error("No pending Horizon dispatch can bind"); item.agentId = safe(agentId, "agent ID"); item.status = "bound"; atomicWriteJson(this.path(parentSessionId), item); return item })
  }
  observeStop(parentSessionId: string, agentId: string): HorizonPendingDispatch {
    return this.locked(() => { const item = this.read(parentSessionId); if (!item || item.agentId !== agentId || item.status === "pending") throw new Error("Horizon stop does not match the bound child"); item.stopObserved = true; if (item.agentCompleted && item.quarantineReason === null) item.status = "completed"; atomicWriteJson(this.path(parentSessionId), item); return item })
  }
  observeAgentCompleted(parentSessionId: string, agentId: string): HorizonPendingDispatch {
    return this.locked(() => { const item = this.read(parentSessionId); if (!item || item.agentId !== agentId || item.status === "pending") throw new Error("Horizon Agent completion does not match the bound child"); item.agentCompleted = true; if (item.stopObserved && item.quarantineReason === null) item.status = "completed"; atomicWriteJson(this.path(parentSessionId), item); return item })
  }
  quarantine(parentSessionId: string, reason: string): HorizonPendingDispatch {
    return this.locked(() => { const item = this.read(parentSessionId); if (!item) throw new Error("No Horizon dispatch can be quarantined"); item.status = "quarantined"; item.quarantineReason = reason.slice(0, 2_000); atomicWriteJson(this.path(parentSessionId), item); return item })
  }
  release(parentSessionId: string): void { this.locked(() => rmSync(this.path(parentSessionId), { force: true })) }
}
