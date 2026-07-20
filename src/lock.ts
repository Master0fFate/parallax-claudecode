import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

interface LockOwner { pid: number; token: string; acquiredAt: string }

function readOwner(lock: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8"))
    if (!value || typeof value !== "object") return null
    const owner = value as Record<string, unknown>
    return typeof owner.pid === "number" && Number.isInteger(owner.pid)
      && typeof owner.token === "string" && owner.token.length > 0
      && typeof owner.acquiredAt === "string"
      ? owner as unknown as LockOwner
      : null
  } catch { return null }
}

function ownerIsAlive(owner: LockOwner | null): boolean {
  if (!owner) return false
  try { process.kill(owner.pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/**
 * Acquire a filesystem directory lock with process ownership and race-safe stale recovery.
 * Reclaim claims have unique, never-reused paths. Every acquirer checks claims before and after
 * mkdir, so a reclaimer can remove an abandoned lock or a not-yet-active contender, but never a
 * lock owner that has entered the protected operation.
 */
export function withDirectoryLock<T>(lock: string, operation: () => T, options: { timeoutMs?: number; staleMs?: number; label: string }): T {
  const timeoutMs = options.timeoutMs ?? 5_000
  const staleMs = options.staleMs ?? 30_000
  const parent = dirname(lock)
  const claimPrefix = `${basename(lock)}.reclaim.`
  const deadline = Date.now() + timeoutMs
  const token = randomUUID()
  mkdirSync(parent, { recursive: true })

  const removeIfOwned = (path: string, ownerToken = token): void => {
    if (readOwner(path)?.token === ownerToken) rmSync(path, { recursive: true, force: true })
  }
  const activeClaims = (): string[] => {
    const claims = readdirSync(parent).filter((name) => name.startsWith(claimPrefix))
    return claims.filter((name) => {
      const path = join(parent, name)
      const owner = readOwner(path)
      if (owner && !ownerIsAlive(owner)) { rmSync(path, { recursive: true, force: true }); return false }
      // A creator may be between mkdir and owner.json. Only reap an ownerless unique claim after
      // a grace period; because names are never reused this cannot delete a replacement claim.
      if (!owner) {
        try { if (Date.now() - statSync(path).mtimeMs > 1_000) { rmSync(path, { recursive: true, force: true }); return false } }
        catch { return false }
      }
      return true
    })
  }

  while (true) {
    let acquired = false
    try {
      if (activeClaims().length) throw Object.assign(new Error("reclaim active"), { code: "EAGAIN" })
      mkdirSync(lock)
      acquired = true
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 })
      if (activeClaims().length) {
        removeIfOwned(lock)
        acquired = false
        throw Object.assign(new Error("reclaim raced acquisition"), { code: "EAGAIN" })
      }
      break
    } catch (error) {
      if (acquired) removeIfOwned(lock)
      const code = (error as NodeJS.ErrnoException).code
      // ENOENT after mkdir means a reclaimer removed this contender before owner.json was
      // installed. It was not active, so retry without touching a potentially replacement path.
      if (code !== "EEXIST" && code !== "EAGAIN" && !(acquired && code === "ENOENT")) throw error

      // Normal contention only waits. Creating claims for every live lock would starve the
      // current owner because claims could continuously cover its release window.
      let looksStale = false
      try { looksStale = Date.now() - statSync(lock).mtimeMs > staleMs }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError }
      if (code !== "EAGAIN" && looksStale) {
        const claim = join(parent, `${claimPrefix}${process.pid}.${randomUUID()}`)
        const claimToken = randomUUID()
        try {
          mkdirSync(claim)
          writeFileSync(join(claim, "owner.json"), JSON.stringify({ pid: process.pid, token: claimToken, acquiredAt: new Date().toISOString() }), { encoding: "utf8", mode: 0o600 })
          try {
            let stale = false
            try { stale = Date.now() - statSync(lock).mtimeMs > staleMs }
            catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError }
            if (stale && !ownerIsAlive(readOwner(lock))) rmSync(lock, { recursive: true, force: true })
          } finally {
            removeIfOwned(claim, claimToken)
          }
        } catch (claimError) {
          removeIfOwned(claim, claimToken)
          if ((claimError as NodeJS.ErrnoException).code !== "EEXIST") throw claimError
        }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out locking ${options.label}`)
      sleep(15)
    }
  }

  try { return operation() }
  finally { removeIfOwned(lock) }
}
