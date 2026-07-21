import { gzipSync } from "node:zlib"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
// @ts-ignore Native ESM release helpers intentionally remain directly executable JavaScript.
import { archiveProblems, computeReportVerdict, parseAuditReport, parseJsonLines, parseRoleFrontmatter, parseTar, redact, roleBoundaryProblems, terminateWindowsProcessTree } from "../scripts/release-proof.mjs"

function tarEntry(name: string, content: string, mode = 0o644): Buffer {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100); header.write(mode.toString(8).padStart(7, "0"), 100, 8)
  header.write(content.length.toString(8).padStart(11, "0"), 124, 12); header.write("0", 156, 1)
  header.write("ustar", 257); header.fill(0x20, 148, 156)
  let sum = 0; for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, "0"), 148, 6); header[154] = 0; header[155] = 0x20
  const body = Buffer.from(content); return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512)])
}

describe("release proof helpers", () => {
  it("redacts credential-shaped output and parses only structured lines", () => {
    expect(redact("token=secret-value sk-ant-1234567890")).toBe("token=[REDACTED] [REDACTED]")
    expect(parseJsonLines('{"ok":1}\nnoise\n{"ok":2}\n')).toEqual([{ ok: 1 }, { ok: 2 }])
  })

  it("parses a real gzip tar header and rejects package-boundary violations", () => {
    const archive = gzipSync(Buffer.concat([tarEntry("package/package.json", "{}"), tarEntry("package/src/secret.ts", "x"), tarEntry("package/.parallax/release-proof/report.json", "{}"), Buffer.alloc(1024)]))
    const entries = parseTar(archive)
    expect(entries.map((entry: { name: string }) => entry.name)).toEqual(["package/package.json", "package/src/secret.ts", "package/.parallax/release-proof/report.json"])
    expect(archiveProblems(entries, { files: ["dist"] })).toEqual(expect.arrayContaining([
      "forbidden asset: src/secret.ts", "outside allowlist: src/secret.ts", "forbidden asset: .parallax/release-proof/report.json",
    ]))
  })

  it("keeps report verdict and publishability fail-closed and coherent", () => {
    const advisorySkip = [{ id: "claude-plugin-init", verdict: "skipped", applicable: false }]
    expect(computeReportVerdict(advisorySkip)).toEqual({ verdict: "pass", publishable: true })
    expect(computeReportVerdict([{ id: "security", verdict: "skipped", applicable: true }])).toEqual({ verdict: "fail", publishable: false })
    expect(computeReportVerdict([{ id: "archive", verdict: "unknown" }])).toEqual({ verdict: "fail", publishable: false })
    expect(computeReportVerdict([{ id: "archive", verdict: "pass" }])).toEqual({ verdict: "pass", publishable: true })
  })

  it("parses complete npm audit counts and fails closed on malformed or inconsistent output", () => {
    const report = JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high: 3, critical: 4, total: 10 } } })
    expect(parseAuditReport(report, "high")).toMatchObject({ auditLevel: "high", applicable: 7, total: 10 })
    expect(() => parseAuditReport("not-json")).toThrow(/malformed/)
    expect(() => parseAuditReport(JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 1 } } }))).toThrow(/inconsistent/)
  })

  it("asserts complete packed native role capabilities without claiming runtime permissions", () => {
    const worker = `---\ntools: Read, Glob, Grep, Edit, Write, Bash, mcp__plugin_parallax-claudecode_parallax__parallax_checkin, mcp__plugin_parallax-claudecode_parallax__parallax_verify, mcp__plugin_parallax-claudecode_parallax__parallax_trace_export\ndisallowedTools: Agent, Task\n---`
    const auditor = `---\ntools: Read, Glob, Grep, mcp__plugin_parallax-claudecode_parallax__horizon_read_plan, mcp__plugin_parallax-claudecode_parallax__horizon_read_state, mcp__plugin_parallax-claudecode_parallax__horizon_active_child, mcp__plugin_parallax-claudecode_parallax__parallax_trace_view\ndisallowedTools: Write, Edit, NotebookEdit, Bash, PowerShell, Agent, Task, mcp__plugin_parallax-claudecode_parallax__parallax_verify, mcp__plugin_parallax-claudecode_parallax__parallax_checkin, mcp__plugin_parallax-claudecode_parallax__horizon_record_audit\n---`
    expect(parseRoleFrontmatter(worker).tools).toContain("Write")
    expect(roleBoundaryProblems(worker, auditor)).toEqual([])
    expect(roleBoundaryProblems(worker.replace("disallowedTools: Agent, Task", "disallowedTools: Agent"), auditor)).toContain("worker forbidden capability is not explicit: Task")
    expect(roleBoundaryProblems(worker, auditor.replace("PowerShell, ", ""))).toContain("auditor forbidden capability is not explicit: PowerShell")
  })

  it("awaits Windows taskkill completion and uses a bounded fallback", async () => {
    vi.useFakeTimers()
    try {
      const closed = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }; closed.kill = vi.fn()
      const closePromise = terminateWindowsProcessTree(42, { spawnProcess: vi.fn(() => closed), timeoutMs: 50 })
      let completed = false; closePromise.then(() => { completed = true })
      await Promise.resolve(); expect(completed).toBe(false)
      closed.emit("close", 0); await expect(closePromise).resolves.toBe("closed")

      const stuck = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }; stuck.kill = vi.fn()
      const timeoutPromise = terminateWindowsProcessTree(43, { spawnProcess: vi.fn(() => stuck), timeoutMs: 50 })
      await vi.advanceTimersByTimeAsync(50)
      await expect(timeoutPromise).resolves.toBe("timeout"); expect(stuck.kill).toHaveBeenCalledWith("SIGKILL")
    } finally { vi.useRealTimers() }
  })
})
