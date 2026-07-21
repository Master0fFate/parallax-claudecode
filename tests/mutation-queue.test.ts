import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { MutationIntentQueue } from "../src/mutation-queue.js"

const roots: string[] = []
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "parallax-queue-test-"))
  roots.push(root)
  return root
}
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

describe("durable mutation intent queue", () => {
  const fingerprint = "a".repeat(64)
  const intent = (toolUseId: string, tool = "Write", target = `${toolUseId}.ts`) => ({ toolUseId, tool, fingerprint, targets: [target] })
  const success = (toolUseId: string, tool = "Write") => ({ toolUseId, tool, fingerprint, outcome: "success" as const, detail: "completed" })
  it("isolates canonical roots and sessions without allowing storage path traversal", () => {
    const root = temporary()
    const canonical = new MutationIntentQueue(root, "session")
    const alias = new MutationIntentQueue(join(root, "."), "session")
    const hostile = new MutationIntentQueue(root, "../../outside")
    expect(alias.path).toBe(canonical.path)
    expect(hostile.path.startsWith(hostile.root)).toBe(true)
    expect(hostile.path).not.toContain("..")
    expect(new MutationIntentQueue(root, "other").path).not.toBe(canonical.path)
  })

  it("allows one pre-execution batch of intents and excludes a concurrent verifier", () => {
    const root = temporary()
    const queue = new MutationIntentQueue(root, "shared")
    queue.record(intent("first"))
    queue.record(intent("second", "Edit"))
    const first = queue.observe([success("first"), success("second", "Edit")])
    expect(first.status).toBe("claimed")
    expect(() => queue.record(intent("third", "Edit"))).toThrow(/active/)
    expect(queue.observe([success("third", "Edit")]).status).toBe("busy")
    expect(queue.read().pending).toEqual([])
    expect(queue.read().active?.intents.map((intent) => intent.toolUseId)).toEqual(["first", "second"])
  })

  it("retains an interrupted claim and conservatively reclaims it only after lease and dead-owner evidence", () => {
    const root = temporary()
    let now = 1_000
    const queue = new MutationIntentQueue(root, "recovery", { leaseMs: 100, now: () => now })
    queue.record(intent("write", "Write", "file.ts"))
    expect(queue.observe([success("write")]).status).toBe("claimed")
    expect(new MutationIntentQueue(root, "recovery", { leaseMs: 100, now: () => now + 200 }).observe([]).status).toBe("busy")

    const stored = JSON.parse(readFileSync(queue.path, "utf8"))
    stored.active.owner.pid = 999_999_999
    stored.active.leaseUntil = new Date(0).toISOString()
    writeFileSync(queue.path, JSON.stringify(stored))
    now = 2_000
    const recovered = queue.observe([])
    expect(recovered).toMatchObject({ status: "claimed", recovered: true })
    expect(queue.read().active?.intents[0]?.toolUseId).toBe("write")
  })

  it("fails closed on malformed durable queue state", () => {
    const root = temporary()
    const queue = new MutationIntentQueue(root, "malformed")
    queue.record(intent("write", "Write", "file.ts"))
    writeFileSync(queue.path, '{"schemaVersion":1')
    expect(() => queue.read()).toThrow()
    expect(() => queue.record(intent("other"))).toThrow()
  })

  it("preserves intents and blocks later records on tool, input, and malformed-batch mismatch", () => {
    const queue = new MutationIntentQueue(temporary(), "mismatch")
    queue.record(intent("write", "Write", "file.ts"))
    expect(queue.observe([{ ...success("write", "Edit"), fingerprint: "b".repeat(64) }]).status).toBe("empty")
    expect(queue.read()).toMatchObject({ pending: [{ toolUseId: "write" }], unresolved: { toolUseIds: ["write"] } })
    expect(() => queue.record(intent("later"))).toThrow(/reconciliation required/)

    const malformed = new MutationIntentQueue(temporary(), "malformed-batch")
    malformed.record(intent("write"))
    malformed.observe([], "tool_calls missing")
    expect(malformed.read()).toMatchObject({ pending: [{ toolUseId: "write" }], unresolved: { reason: "tool_calls missing" } })
  })

  it("recovers an unresolved intent only from an exact later observation", () => {
    const queue = new MutationIntentQueue(temporary(), "reconcile")
    queue.record(intent("write"))
    queue.observe([{ ...success("write"), outcome: "unknown", detail: "ambiguous response" }])
    expect(queue.read().unresolved).not.toBeNull()
    expect(queue.observe([success("write")]).status).toBe("claimed")
    expect(queue.read().unresolved).toBeNull()
  })

  it("marks empty evidence unresolved without dropping pending or active work", () => {
    const pending = new MutationIntentQueue(temporary(), "empty-pending")
    pending.record(intent("first"))
    pending.record(intent("second", "Edit"))
    pending.rejectEvidence("official batch was empty")
    expect(pending.read()).toMatchObject({
      pending: [{ toolUseId: "first" }, { toolUseId: "second" }],
      unresolved: { reason: "official batch was empty", toolUseIds: ["first", "second"] },
    })
    expect(() => pending.record(intent("later"))).toThrow(/reconciliation required/)
    expect(pending.observe([success("first"), success("second", "Edit")]).status).toBe("claimed")
    expect(pending.read().unresolved).toBeNull()

    const active = new MutationIntentQueue(temporary(), "empty-active")
    active.record(intent("active"))
    expect(active.observe([success("active")]).status).toBe("claimed")
    active.rejectEvidence("official batch was empty")
    expect(active.read()).toMatchObject({
      active: { intents: [{ toolUseId: "active" }] },
      unresolved: { reason: "official batch was empty", toolUseIds: ["active"] },
    })
  })

  it("does not create unresolved state for an empty queue", () => {
    const queue = new MutationIntentQueue(temporary(), "genuinely-empty")
    queue.rejectEvidence("official batch was empty")
    expect(queue.read()).toMatchObject({ pending: [], active: null, unresolved: null })
  })
})
