import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  VerificationLedger,
  createSessionState,
  createVerificationRecord,
  runVerification,
  validateSessionState,
  validateVerificationRecord,
} from "../src/index.js"
import type { ProjectDetection, VerificationRecord } from "../src/types.js"
import { FIXED_TIME, TestWorkspace } from "./fixtures.js"

const workspaces: TestWorkspace[] = []
function workspace(label: string): TestWorkspace {
  const value = new TestWorkspace(label)
  workspaces.push(value)
  return value
}
afterEach(() => { while (workspaces.length) workspaces.pop()!.cleanup() })

function project(root: string): ProjectDetection {
  return { type: "node", root, markers: ["package.json"], packageManager: "npm" }
}

function receipt(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return createVerificationRecord({
    sessionId: "session", source: "manual", command: "node", args: ["--version"], cwd: process.cwd(), timeoutMs: 100,
    durationMs: 1, exitCode: 0, verdict: "pass", changedFiles: [], stdout: "ok", stderr: "", combined: "ok",
    outputTruncated: false, timedOut: false, skipReason: null, ...overrides,
  })
}

describe("schema-v2 verification receipts", () => {
  it("accepts only canonical manual and automatic sources", () => {
    expect(validateVerificationRecord(receipt({ source: "manual" })).source).toBe("manual")
    expect(validateVerificationRecord(receipt({ source: "automatic" })).source).toBe("automatic")
    expect(() => validateVerificationRecord({ ...receipt(), source: "PostToolBatch" })).toThrow(/schema-v2/)
  })

  it("serializes exactly the schema-v2 fields while retaining typed v1 API aliases", () => {
    const record = receipt({ changedFiles: ["a.ts"] })
    expect(record.timestamp).toBe(record.startedAt)
    expect(record.files).toEqual(record.changedFiles)
    expect(Object.keys(record).sort()).toEqual([
      "args", "changedFiles", "combined", "command", "cwd", "durationMs", "exitCode", "id",
      "outputTruncated", "schemaVersion", "sessionId", "skipReason", "source", "startedAt", "stderr",
      "stdout", "timedOut", "timeoutMs", "verdict",
    ].sort())
    const serialized = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
    expect(serialized).not.toHaveProperty("timestamp")
    expect(serialized).not.toHaveProperty("files")
  })

  it("accepts every exact verdict and rejects contradictory evidence", () => {
    expect(validateVerificationRecord(receipt()).verdict).toBe("pass")
    expect(validateVerificationRecord(receipt({ verdict: "fail", exitCode: 7 })).verdict).toBe("fail")
    expect(validateVerificationRecord(receipt({ verdict: "skipped", command: null, args: [], exitCode: null, skipReason: "No command" })).verdict).toBe("skipped")
    expect(validateVerificationRecord(receipt({ verdict: "unknown", exitCode: null, timedOut: true, skipReason: "Timed out" })).verdict).toBe("unknown")
    expect(() => validateVerificationRecord({ ...receipt(), timedOut: true })).toThrow(/contradictory/)
    expect(() => validateVerificationRecord({ ...receipt({ verdict: "fail", exitCode: 0 }) })).toThrow(/contradictory/)
    expect(() => validateVerificationRecord({ ...receipt({ verdict: "skipped", command: null, args: [], exitCode: null, skipReason: null }) })).toThrow(/contradictory/)
    expect(() => validateVerificationRecord({ ...receipt({ verdict: "unknown", exitCode: null, skipReason: null }) })).toThrow(/explicit reason/)
    expect(() => receipt({ verdict: "unknown", exitCode: 0, skipReason: "Indeterminate" })).toThrow(/null exitCode/)
    expect(() => receipt({ verdict: "unknown", exitCode: 7, skipReason: "Indeterminate" })).toThrow(/null exitCode/)
    expect(() => validateVerificationRecord({ ...receipt(), extra: "unknown" })).toThrow(/schema-v2/)
  })

  it("bounds bytes and lines, discloses truncation, and orders changed files", async () => {
    const root = workspace("receipt-output").root
    const result = await runVerification(project(root), ["z.ts", ".\\a.ts", "z.ts", "b.ts"], {
      commands: [{ command: process.execPath, args: ["-e", "console.log('1111111111\\n2222222222\\n3333333333\\n4444444444')"], label: "output" }],
      outputMaxBytes: 24,
      outputMaxLines: 2,
    })
    expect(result.changedFiles).toEqual(["a.ts", "b.ts", "z.ts"])
    expect(result.outputTruncated).toBe(true)
    for (const output of [result.stdout, result.stderr, result.combined]) {
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(24)
      expect(output.split("\n").length).toBeLessThanOrEqual(2)
    }
  })

  it("reports timeout, cancellation, and spawn errors as unknown", async () => {
    const root = workspace("receipt-indeterminate").root
    const timeout = await runVerification(project(root), [], { timeoutMs: 20, commands: [{ command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], label: "timeout" }] })
    expect(timeout).toMatchObject({ verdict: "unknown", exitCode: null, timedOut: true })
    const controller = new AbortController()
    controller.abort()
    const cancelled = await runVerification(project(root), [], { signal: controller.signal, commands: [{ command: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"], label: "cancel" }] })
    expect(cancelled).toMatchObject({ verdict: "unknown", exitCode: null, timedOut: false })
    const spawnError = await runVerification(project(root), [], { commands: [{ command: "definitely-not-a-parallax-command", args: [], label: "spawn" }] })
    expect(spawnError).toMatchObject({ verdict: "unknown", exitCode: null })
    expect(spawnError.skipReason).toMatch(/spawn/i)
  })

  it("appends validated receipts, deduplicates IDs, and refuses append after a torn final line", () => {
    const root = workspace("receipt-ledger").root
    const ledger = new VerificationLedger(root)
    const record = receipt()
    expect(ledger.append(record)).toBe(true)
    const beforeDuplicate = readFileSync(ledger.path, "utf8")
    expect(ledger.append(record)).toBe(false)
    expect(readFileSync(ledger.path, "utf8")).toBe(beforeDuplicate)
    const collision = receipt({ id: record.id, stdout: "different", combined: "different" })
    expect(() => ledger.append(collision)).toThrow(/ID collision/)
    expect(readFileSync(ledger.path, "utf8")).toBe(beforeDuplicate)
    appendFileSync(ledger.path, '{"schemaVersion":2')
    expect(ledger.read()).toEqual([record])
    const beforeRefusal = readFileSync(ledger.path, "utf8")
    expect(() => ledger.append(receipt())).toThrow(/torn final line.*recover/i)
    expect(readFileSync(ledger.path, "utf8")).toBe(beforeRefusal)
    expect(ledger.read()).toEqual([record])
    appendFileSync(ledger.path, "\n")
    expect(() => ledger.read()).toThrow(/line 2/)
  })

  it("ignores a non-newline-terminated final suffix even when it is valid JSON", () => {
    const root = workspace("receipt-ledger-valid-json-tail").root
    const ledger = new VerificationLedger(root)
    const record = receipt()
    ledger.append(record)
    appendFileSync(ledger.path, '{"schemaVersion":2}')
    expect(ledger.read()).toEqual([record])
    expect(() => ledger.append(receipt())).toThrow(/torn final line/i)
  })

  it("detaches and freezes canonical receipts returned by validation and ledger reads", () => {
    const root = workspace("receipt-immutability").root
    const mutable = { ...receipt(), args: ["--version"], changedFiles: ["a.ts"] }
    const canonical = validateVerificationRecord(mutable)
    mutable.args.push("--help")
    mutable.changedFiles.push("b.ts")
    expect(canonical.args).toEqual(["--version"])
    expect(canonical.changedFiles).toEqual(["a.ts"])
    expect(Object.isFrozen(canonical)).toBe(true)
    expect(Object.isFrozen(canonical.args)).toBe(true)
    expect(Object.isFrozen(canonical.changedFiles)).toBe(true)
    expect(() => (canonical.args as string[]).push("--help")).toThrow()

    const ledger = new VerificationLedger(root)
    ledger.append(canonical)
    const fromLedger = ledger.read()[0]!
    expect(Object.isFrozen(fromLedger)).toBe(true)
    expect(() => (fromLedger.changedFiles as string[]).push("b.ts")).toThrow()
    expect(ledger.read()[0]!.changedFiles).toEqual(["a.ts"])
  })

  it("explicitly archives exact invalid ledger bytes and starts a fresh canonical ledger", () => {
    const root = workspace("receipt-ledger-recovery").root
    const ledger = new VerificationLedger(root)
    const valid = receipt()
    ledger.append(valid)
    appendFileSync(ledger.path, "{\"schemaVersion\":2,\"invalid\":true}\n")
    const original = readFileSync(ledger.path)

    expect(() => ledger.read()).toThrow(/line 2/)
    expect(() => ledger.append(receipt())).toThrow(/line 2/)
    const recovered = ledger.recoverInvalid("test schema transition", { now: () => new Date(FIXED_TIME) })
    expect(recovered).toMatchObject({ recovered: true, idempotent: false, lineCount: 2, validationPassedLineCount: 1, validationFailedLineCount: 1 })
    expect(readFileSync(recovered.archivePath)).toEqual(original)
    expect(recovered.sha256).toBe(createHash("sha256").update(original).digest("hex"))
    const manifest = JSON.parse(readFileSync(recovered.manifestPath, "utf8")) as Record<string, unknown>
    expect(manifest).toMatchObject({
      schemaVersion: 1, kind: "parallax-verification-ledger-recovery", sourcePath: ledger.path,
      archivePath: recovered.archivePath, sha256: recovered.sha256, recoveredAt: FIXED_TIME,
      reason: "test schema transition", lineCount: 2, validationPassedLineCount: 1,
      validationFailedLineCount: 1, archiveStatus: "non-canonical",
    })
    expect(ledger.read()).toEqual([])
    expect(ledger.diagnostics()).toMatchObject({
      canonicalValid: true,
      archives: [{ archivePath: recovered.archivePath, manifestPath: recovered.manifestPath, byteEqualityVerified: true, canonical: false }],
      invalidManifests: [],
    })
    expect(ledger.recoverInvalid("ignored on idempotent retry")).toMatchObject({ recovered: false, idempotent: true, archivePath: recovered.archivePath })
    const fresh = receipt()
    expect(ledger.append(fresh)).toBe(true)
    expect(ledger.read()).toEqual([fresh])
    expect(readFileSync(recovered.archivePath)).toEqual(original)
  })

  it("rejects unsafe recovery manifests and symbolic-link archive paths", () => {
    const unsafeRoot = workspace("receipt-ledger-unsafe-manifest").root
    const unsafe = new VerificationLedger(unsafeRoot)
    mkdirSync(unsafe.archiveDirectory, { recursive: true })
    writeFileSync(unsafe.path, "{}\n")
    const manifestPath = join(unsafe.archiveDirectory, "unsafe.manifest.json")
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1, kind: "parallax-verification-ledger-recovery", sourcePath: unsafe.path,
      archivePath: join(unsafeRoot, "outside.jsonl"), sha256: "0".repeat(64), recoveredAt: FIXED_TIME,
      reason: "unsafe", lineCount: 1, validationPassedLineCount: 0, validationFailedLineCount: 1,
      archiveStatus: "non-canonical",
    }))
    expect(unsafe.diagnostics().invalidManifests).toMatchObject([{ path: manifestPath }])
    const beforeUnsafe = readFileSync(unsafe.path)
    expect(() => unsafe.recoverInvalid("must refuse unsafe manifest")).toThrow(/invalid recovery manifest/i)
    expect(readFileSync(unsafe.path)).toEqual(beforeUnsafe)

    const linkRoot = workspace("receipt-ledger-symlink").root
    const outside = workspace("receipt-ledger-symlink-target").root
    const linked = new VerificationLedger(linkRoot)
    mkdirSync(dirname(linked.path), { recursive: true })
    writeFileSync(linked.path, "{}\n")
    symlinkSync(outside, linked.archiveDirectory, "junction")
    const beforeLink = readFileSync(linked.path)
    expect(() => linked.recoverInvalid("must refuse symlink")).toThrow(/symbolic link/i)
    expect(readFileSync(linked.path)).toEqual(beforeLink)
  })

  it("refuses concurrent recovery and preserves the source on archive collision", () => {
    const concurrentRoot = workspace("receipt-ledger-recovery-lock").root
    const concurrent = new VerificationLedger(concurrentRoot)
    mkdirSync(dirname(concurrent.path), { recursive: true })
    writeFileSync(concurrent.path, "{}\n")
    const lock = `${concurrent.path}.lock`
    mkdirSync(lock)
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "active", acquiredAt: FIXED_TIME }))
    const beforeConcurrent = readFileSync(concurrent.path)
    expect(() => concurrent.recoverInvalid("concurrent", { lockTimeoutMs: 20 })).toThrow(/Timed out locking/)
    expect(readFileSync(concurrent.path)).toEqual(beforeConcurrent)

    const collisionRoot = workspace("receipt-ledger-recovery-collision").root
    const collision = new VerificationLedger(collisionRoot)
    mkdirSync(dirname(collision.path), { recursive: true })
    const original = Buffer.from("{}\n")
    writeFileSync(collision.path, original)
    const digest = createHash("sha256").update(original).digest("hex")
    mkdirSync(collision.archiveDirectory)
    const archive = join(collision.archiveDirectory, `verification-ledger.20260102T030405000Z.${digest}.jsonl`)
    writeFileSync(archive, "collision")
    expect(() => collision.recoverInvalid("collision", { now: () => new Date(FIXED_TIME) })).toThrow(/archive collision/i)
    expect(readFileSync(collision.path)).toEqual(original)
    expect(() => collision.read()).toThrow(/line 1/)
  })

  it("explicitly migrates persisted trace-v1 evidence", () => {
    const root = workspace("receipt-migration").root
    const state = createSessionState("migrate", root)
    const legacy = {
      id: "legacy", timestamp: new Date().toISOString(), command: "test", files: ["b.ts", "a.ts"], verdict: "fail",
      exitCode: -1, durationMs: 10, stdout: "", stderr: "Verification timed out",
    }
    ;(state.trace.verifications as unknown[]).push(legacy)
    const migrated = validateSessionState(state).trace.verifications[0]!
    expect(migrated).toMatchObject({ schemaVersion: 2, source: "automatic", verdict: "unknown", timedOut: true, changedFiles: ["a.ts", "b.ts"] })
  })
})
