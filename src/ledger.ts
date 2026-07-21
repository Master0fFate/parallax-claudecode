import { createHash, randomUUID } from "node:crypto"
import {
  appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  linkSync, readFileSync, readdirSync, renameSync, rmSync, writeSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { withDirectoryLock } from "./lock.js"
import { validateVerificationRecord } from "./trace.js"
import type { VerificationRecord } from "./types.js"

export interface LedgerRecoveryManifest {
  readonly schemaVersion: 1
  readonly kind: "parallax-verification-ledger-recovery"
  readonly sourcePath: string
  readonly archivePath: string
  readonly sha256: string
  readonly recoveredAt: string
  readonly reason: string
  readonly lineCount: number
  readonly validationPassedLineCount: number
  readonly validationFailedLineCount: number
  readonly archiveStatus: "non-canonical"
}

export interface LedgerArchiveDiagnostic {
  readonly manifestPath: string
  readonly archivePath: string
  readonly sha256: string
  readonly recoveredAt: string
  readonly reason: string
  readonly lineCount: number
  readonly validationPassedLineCount: number
  readonly validationFailedLineCount: number
  readonly byteEqualityVerified: boolean
  readonly canonical: false
}

export interface LedgerDiagnostics {
  readonly canonicalPath: string
  readonly canonicalValid: boolean
  readonly canonicalError: string | null
  readonly archives: readonly LedgerArchiveDiagnostic[]
  readonly invalidManifests: readonly { path: string; error: string }[]
}

export interface LedgerRecoveryResult {
  readonly recovered: boolean
  readonly idempotent: boolean
  readonly archivePath: string
  readonly manifestPath: string
  readonly sha256: string
  readonly lineCount: number
  readonly validationPassedLineCount: number
  readonly validationFailedLineCount: number
}

interface RecoveryOptions {
  now?: () => Date
  lockTimeoutMs?: number
}

const MANIFEST_KIND = "parallax-verification-ledger-recovery"

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function durableTemporary(path: string, bytes: Buffer): string {
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporary, "wx", 0o600)
    writeSync(descriptor, bytes)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    return temporary
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function atomicCreate(path: string, bytes: Buffer): void {
  const temporary = durableTemporary(path, bytes)
  try { linkSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

function atomicReplace(path: string, bytes: Buffer): void {
  const temporary = durableTemporary(path, bytes)
  try { renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}

function isInside(parent: string, child: string): boolean {
  const value = relative(parent, child)
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
}

function recoveryTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("Ledger recovery time must be valid")
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "")
}

/** Append-only project evidence store. Existing records are never rewritten. */
export class VerificationLedger {
  readonly projectRoot: string
  readonly path: string
  readonly archiveDirectory: string

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot)
    this.path = join(this.projectRoot, ".parallax", "verification-ledger.jsonl")
    this.archiveDirectory = join(this.projectRoot, ".parallax", "ledger-archive")
  }

  private assertSafePath(path: string, allowMissing = false): void {
    const target = resolve(path)
    if (!isInside(this.projectRoot, target)) throw new Error(`Ledger path escapes project root: ${target}`)
    const root = lstatSync(this.projectRoot)
    if (root.isSymbolicLink()) throw new Error(`Ledger project root must not be a symbolic link: ${this.projectRoot}`)
    const components = relative(this.projectRoot, target).split(sep).filter(Boolean)
    let current = this.projectRoot
    for (const component of components) {
      current = join(current, component)
      try {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink()) throw new Error(`Ledger path must not contain symbolic links: ${current}`)
      } catch (error) {
        if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
    }
  }

  private readManifest(path: string): LedgerRecoveryManifest {
    this.assertSafePath(path)
    const value: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Recovery manifest must be an object")
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const expected = [
      "archivePath", "archiveStatus", "kind", "lineCount", "reason", "recoveredAt", "schemaVersion", "sha256",
      "sourcePath", "validationFailedLineCount", "validationPassedLineCount",
    ].sort()
    if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error("Recovery manifest has unexpected fields")
    if (record.schemaVersion !== 1 || record.kind !== MANIFEST_KIND || record.archiveStatus !== "non-canonical") throw new Error("Recovery manifest identity is invalid")
    if (record.sourcePath !== this.path || typeof record.archivePath !== "string") throw new Error("Recovery manifest source or archive path is invalid")
    const archivePath = resolve(record.archivePath)
    if (!isInside(this.archiveDirectory, archivePath) || dirname(archivePath) !== this.archiveDirectory) throw new Error("Recovery manifest archive path escapes the archive directory")
    this.assertSafePath(archivePath)
    if (typeof record.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error("Recovery manifest SHA-256 is invalid")
    if (typeof record.recoveredAt !== "string" || Number.isNaN(Date.parse(record.recoveredAt))) throw new Error("Recovery manifest time is invalid")
    if (typeof record.reason !== "string" || !record.reason.trim()) throw new Error("Recovery manifest reason is invalid")
    for (const key of ["lineCount", "validationPassedLineCount", "validationFailedLineCount"] as const) {
      if (!Number.isInteger(record[key]) || (record[key] as number) < 0) throw new Error(`Recovery manifest ${key} is invalid`)
    }
    if ((record.validationPassedLineCount as number) + (record.validationFailedLineCount as number) !== record.lineCount) {
      throw new Error("Recovery manifest line counts are inconsistent")
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: MANIFEST_KIND,
      sourcePath: this.path,
      archivePath,
      sha256: record.sha256,
      recoveredAt: record.recoveredAt,
      reason: record.reason,
      lineCount: record.lineCount,
      validationPassedLineCount: record.validationPassedLineCount,
      validationFailedLineCount: record.validationFailedLineCount,
      archiveStatus: "non-canonical",
    } as LedgerRecoveryManifest)
  }

  diagnostics(): LedgerDiagnostics {
    let canonicalValid = true
    let canonicalError: string | null = null
    try { this.read() }
    catch (error) { canonicalValid = false; canonicalError = error instanceof Error ? error.message : String(error) }
    const archives: LedgerArchiveDiagnostic[] = []
    const invalidManifests: { path: string; error: string }[] = []
    this.assertSafePath(this.archiveDirectory, true)
    if (existsSync(this.archiveDirectory)) {
      this.assertSafePath(this.archiveDirectory)
      for (const name of readdirSync(this.archiveDirectory).filter((item) => item.endsWith(".manifest.json")).sort()) {
        const manifestPath = join(this.archiveDirectory, name)
        try {
          const manifest = this.readManifest(manifestPath)
          const equality = sha256(readFileSync(manifest.archivePath)) === manifest.sha256
          archives.push(Object.freeze({
            manifestPath, archivePath: manifest.archivePath, sha256: manifest.sha256, recoveredAt: manifest.recoveredAt,
            reason: manifest.reason, lineCount: manifest.lineCount,
            validationPassedLineCount: manifest.validationPassedLineCount,
            validationFailedLineCount: manifest.validationFailedLineCount,
            byteEqualityVerified: equality, canonical: false,
          }))
        } catch (error) {
          invalidManifests.push({ path: manifestPath, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    return Object.freeze({
      canonicalPath: this.path, canonicalValid, canonicalError,
      archives: Object.freeze(archives), invalidManifests: Object.freeze(invalidManifests),
    })
  }

  read(): VerificationRecord[] {
    let content: string
    try { content = readFileSync(this.path, "utf8") }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    if (content === "") return []
    const hasFinalNewline = content.endsWith("\n")
    const lines = content.split("\n")
    if (hasFinalNewline) lines.pop()
    const records: VerificationRecord[] = []
    const ids = new Set<string>()
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      if (!line.trim()) throw new Error(`Invalid empty verification ledger line ${index + 1}`)
      try {
        const record = validateVerificationRecord(JSON.parse(line))
        if (ids.has(record.id)) throw new Error(`Duplicate verification receipt ID: ${record.id}`)
        ids.add(record.id)
        records.push(record)
      } catch (error) {
        // Only newline-terminated records are committed. An interrupted suffix
        // can happen to be valid JSON while still being an incomplete receipt.
        if (!hasFinalNewline && index === lines.length - 1) break
        throw new Error(`Invalid verification ledger line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return records
  }

  /**
   * Explicitly quarantine a newline-terminated ledger that fails current validation.
   * Archived bytes remain durable evidence but are never returned by read().
   */
  recoverInvalid(reason: string, options: RecoveryOptions = {}): LedgerRecoveryResult {
    if (!reason.trim()) throw new Error("Ledger recovery requires a non-empty reason")
    this.assertSafePath(dirname(this.path), true)
    return withDirectoryLock(`${this.path}.lock`, () => {
      this.assertSafePath(dirname(this.path))
      this.assertSafePath(this.path, true)
      const original = existsSync(this.path) ? readFileSync(this.path) : Buffer.alloc(0)
      let validationError: unknown = null
      try { this.read() }
      catch (error) { validationError = error }

      const diagnostics = this.diagnostics()
      if (diagnostics.invalidManifests.length) {
        throw new Error(`Ledger recovery refused invalid recovery manifest: ${diagnostics.invalidManifests[0]!.path}`)
      }
      if (!validationError) {
        const prior = original.length === 0 ? diagnostics.archives.at(-1) : undefined
        if (prior?.byteEqualityVerified) {
          return Object.freeze({
            recovered: false, idempotent: true, archivePath: prior.archivePath, manifestPath: prior.manifestPath,
            sha256: prior.sha256, lineCount: prior.lineCount,
            validationPassedLineCount: prior.validationPassedLineCount,
            validationFailedLineCount: prior.validationFailedLineCount,
          })
        }
        throw new Error("Ledger recovery requires a canonical ledger that fails strict validation")
      }
      if (!original.length || original[original.length - 1] !== 0x0a) {
        throw new Error("Ledger recovery refuses a torn or non-newline-terminated ledger")
      }

      const lines = original.toString("utf8").split("\n")
      lines.pop()
      let passed = 0
      let failed = 0
      for (const line of lines) {
        try { validateVerificationRecord(JSON.parse(line)); passed += 1 }
        catch { failed += 1 }
      }
      if (failed === 0) throw new Error("Ledger recovery found no invalid records to quarantine")

      const digest = sha256(original)
      const resumed = diagnostics.archives.find((archive) => archive.sha256 === digest && archive.reason === reason && archive.byteEqualityVerified)
      let archivePath: string
      let manifestPath: string
      if (resumed) {
        archivePath = resumed.archivePath
        manifestPath = resumed.manifestPath
      } else {
        mkdirSync(this.archiveDirectory, { recursive: true, mode: 0o700 })
        this.assertSafePath(this.archiveDirectory)
        const recoveredAt = (options.now?.() ?? new Date()).toISOString()
        const stem = `verification-ledger.${recoveryTimestamp(new Date(recoveredAt))}.${digest}`
        archivePath = join(this.archiveDirectory, `${stem}.jsonl`)
        manifestPath = join(this.archiveDirectory, `${stem}.manifest.json`)
        this.assertSafePath(archivePath, true)
        this.assertSafePath(manifestPath, true)
        if (existsSync(archivePath) || existsSync(manifestPath)) throw new Error(`Ledger recovery archive collision: ${stem}`)
        atomicCreate(archivePath, original)
        if (!readFileSync(archivePath).equals(original)) throw new Error("Ledger recovery archive does not exactly match original bytes")
        const manifest: LedgerRecoveryManifest = {
          schemaVersion: 1, kind: MANIFEST_KIND, sourcePath: this.path, archivePath, sha256: digest,
          recoveredAt, reason, lineCount: lines.length, validationPassedLineCount: passed,
          validationFailedLineCount: failed, archiveStatus: "non-canonical",
        }
        try { atomicCreate(manifestPath, Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8")) }
        catch (error) { rmSync(archivePath, { force: true }); throw error }
        const committed = this.readManifest(manifestPath)
        if (committed.sha256 !== sha256(readFileSync(committed.archivePath))) {
          throw new Error("Ledger recovery manifest does not match archived bytes")
        }
      }

      atomicReplace(this.path, Buffer.alloc(0))
      if (this.read().length !== 0) throw new Error("Ledger recovery failed to initialize a fresh canonical ledger")
      return Object.freeze({
        recovered: true, idempotent: false, archivePath, manifestPath, sha256: digest,
        lineCount: lines.length, validationPassedLineCount: passed, validationFailedLineCount: failed,
      })
    }, { label: "Parallax verification ledger recovery", ...(options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs }) })
  }

  /** Returns false when the exact receipt ID is already present. */
  append(record: VerificationRecord): boolean {
    const validated = validateVerificationRecord(record)
    mkdirSync(dirname(this.path), { recursive: true })
    return withDirectoryLock(`${this.path}.lock`, () => {
      let content = ""
      try { content = readFileSync(this.path, "utf8") }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (content && !content.endsWith("\n")) {
        throw new Error("Cannot append verification receipt: ledger has a torn final line; recover the torn suffix before retrying")
      }
      const prior = this.read().find((candidate) => candidate.id === validated.id)
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(validated)) throw new Error(`Verification receipt ID collision: ${validated.id}`)
        return false
      }
      appendFileSync(this.path, `${JSON.stringify(validated)}\n`, { encoding: "utf8", mode: 0o600 })
      return true
    }, { label: "Parallax verification ledger" })
  }
}
