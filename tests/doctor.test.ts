import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { formatDoctorMarkdown, runDoctor, type DoctorCommandResult } from "../src/doctor.js"

const roots: string[] = []

function fixture(): string {
  const root = join(tmpdir(), `parallax-doctor-${process.pid}-${Math.random().toString(16).slice(2)}`)
  roots.push(root)
  mkdirSync(root, { recursive: true })
  for (const path of ["package.json", ".claude-plugin", "agents", "skills", "hooks", "dist"]) {
    cpSync(join(process.cwd(), path), join(root, path), { recursive: true })
  }
  cpSync(join(process.cwd(), ".mcp.json"), join(root, ".mcp.json"))
  return root
}

function claude(args: string[]): DoctorCommandResult {
  if (args[0] === "--version") return { status: 0, stdout: "2.1.215 (Claude Code)\n", stderr: "" }
  if (args[1] === "list" && args[2] === "--json") return { status: 0, stdout: JSON.stringify([{ id: "parallax-claudecode@parallax-local", version: "0.2.1", enabled: true }]), stderr: "" }
  return { status: 0, stdout: JSON.stringify([{ name: "parallax-local" }]), stderr: "" }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("lifecycle doctor", () => {
  it("returns a stable healthy machine report and human Markdown", () => {
    const report = runDoctor({ root: fixture(), home: tmpdir(), runClaude: claude, now: () => new Date("2026-07-21T00:00:00.000Z") })
    expect(report).toMatchObject({ schemaVersion: 1, healthy: true, generatedAt: "2026-07-21T00:00:00.000Z", product: { version: "0.2.1", supportedClaude: ">=2.1.215 <3" } })
    expect(Object.keys(report)).toEqual(["schemaVersion", "healthy", "generatedAt", "product", "paths", "permissions", "checks"])
    expect(formatDoctorMarkdown(report)).toContain("**Verdict:** HEALTHY")
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
    const inventory = report.checks.find((item) => item.id === "runtime-inventory")!
    expect(inventory.details?.toolCount).toBeGreaterThan(0)
    expect(inventory.details?.hookEvents).toEqual(Object.keys(JSON.parse(readFileSync(join(process.cwd(), "hooks", "hooks.json"), "utf8")).hooks).sort())
    expect(rootContainsSource(report)).toBe(false)
  })

  it("uses packed assets while inspecting a separate external project root", () => {
    const packageRoot = fixture(); const projectRoot = join(tmpdir(), `parallax-external-${process.pid}-${Date.now()}`); roots.push(projectRoot); mkdirSync(projectRoot)
    const report = runDoctor({ packageRoot, projectRoot, home: join(projectRoot, "home"), runClaude: claude })
    expect(report.healthy).toBe(true)
    expect(report.checks.find((item) => item.id === "runtime-inventory")?.level).toBe("pass")
    expect(JSON.stringify(report)).not.toContain(packageRoot)
    expect(JSON.stringify(report)).not.toContain(projectRoot)
  })

  it("fails safely for unavailable or malformed Claude output and corrupt durable storage", () => {
    const root = fixture()
    mkdirSync(join(root, ".parallax", "mutation-intents", "bad"), { recursive: true })
    writeFileSync(join(root, ".parallax", "mutation-intents", "bad", "queue.json"), JSON.stringify({ schemaVersion: 1, projectRoot: root, sessionId: "bad", pending: [{}], active: null, unresolved: null, updatedAt: new Date().toISOString() }))
    const unavailable = (args: string[]): DoctorCommandResult => args[0] === "--version"
      ? { status: null, stdout: "", stderr: `${root} token-super-secret`, errorCode: "ENOENT" }
      : { status: 0, stdout: "not-json", stderr: `${root} token-super-secret` }
    const report = runDoctor({ root, home: join(root, "home"), runClaude: unavailable })
    expect(report.healthy).toBe(false)
    expect(report.checks.find((item) => item.id === "claude-version")?.details?.diagnostic).toBe("command-unavailable")
    expect(report.checks.find((item) => item.id === "native-registration")?.level).toBe("fail")
    expect(report.checks.find((item) => item.id === "storage-health")?.level).toBe("fail")
    expect(JSON.stringify(report)).not.toContain("token-super-secret")
    expect(JSON.stringify(report)).not.toContain(root)
  })

  it("CLI emits parseable unhealthy JSON without a stack dump from an external cwd", () => {
    const projectRoot = join(tmpdir(), `parallax-cli-${process.pid}-${Date.now()}`); roots.push(projectRoot); mkdirSync(join(projectRoot, ".parallax"), { recursive: true })
    // Keep the CLI outcome deterministic regardless of the developer's global
    // Claude plugin registration.
    writeFileSync(join(projectRoot, ".parallax", "config.json"), "{ malformed")
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "doctor.mjs"), "--json"], { cwd: projectRoot, encoding: "utf8" })
    expect(result.status).not.toBe(0)
    expect(() => JSON.parse(result.stdout || result.stderr)).not.toThrow()
    expect(`${result.stdout}${result.stderr}`).not.toContain("    at ")
  })

  it("reports malformed config, unwritable paths, stale cache, and incompatible state without leaking secrets", () => {
    const root = fixture()
    mkdirSync(join(root, ".parallax", "sessions", "bad"), { recursive: true })
    writeFileSync(join(root, ".parallax", "sessions", "bad", "state.json"), '{"schemaVersion":999}')
    writeFileSync(join(root, ".parallax", "config.json"), '{"verificationCommand":"token-super-secret"}')
    const staleClaude = (args: string[]): DoctorCommandResult => args[0] === "--version"
      ? { status: 0, stdout: "2.1.215 (Claude Code)", stderr: "" }
      : args[1] === "list" ? { status: 0, stdout: JSON.stringify([{ id: "parallax-claudecode@parallax-local", version: "0.0.1" }]), stderr: "" }
        : { status: 0, stdout: JSON.stringify([{ name: "parallax-local" }]), stderr: "" }
    const report = runDoctor({ root, home: tmpdir(), runClaude: staleClaude, isWritable: () => false })
    expect(report.healthy).toBe(false)
    expect(report.checks.filter((item) => item.level === "fail").map((item) => item.id)).toEqual(expect.arrayContaining(["native-registration", "config", "path-writeability", "storage-health"]))
    expect(JSON.stringify(report)).not.toContain("token-super-secret")
    expect(JSON.stringify(report)).not.toContain(root)
  })

  it("publishes exact least-privilege role declarations and flags unsupported fields", () => {
    const root = fixture()
    let report = runDoctor({ root, home: tmpdir(), runClaude: claude })
    expect(report.permissions["horizon-worker"]!.tools).toContain("Bash")
    expect(report.permissions["horizon-auditor"]!.tools).not.toContain("Bash")
    const path = join(root, "agents", "horizon-auditor.md")
    writeFileSync(path, readFileSync(path, "utf8").replace("model: inherit", "permissionMode: bypassPermissions\nmodel: inherit"))
    report = runDoctor({ root, home: tmpdir(), runClaude: claude })
    expect(report.permissions["horizon-auditor"]!.unsupportedFields).toEqual(["permissionMode"])
    expect(report.checks.find((item) => item.id === "role-permissions")!.level).toBe("fail")
  })
})

function rootContainsSource(report: ReturnType<typeof runDoctor>): boolean {
  return JSON.stringify(report).includes("src/") || JSON.stringify(report).includes("src\\")
}
