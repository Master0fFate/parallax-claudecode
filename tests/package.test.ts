import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

describe("publishable package boundary", () => {
  it("verifies required runtime assets and rejects development or state files", () => {
    const script = join(process.cwd(), "scripts", "verify-package.mjs")
    const result = spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8" })
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toMatch(/verified \d+ required assets/)
  }, 20_000)

  it("uses Claude's plugin-qualified MCP tool names in restricted components", () => {
    const restricted = [
      join(process.cwd(), "agents", "parallax.md"),
      join(process.cwd(), "skills", "status", "SKILL.md"),
      join(process.cwd(), "skills", "trace", "SKILL.md"),
    ].map((path) => readFileSync(path, "utf8"))
    for (const text of restricted) {
      expect(text).not.toContain("mcp__parallax__")
      expect(text).toContain("mcp__plugin_parallax-claudecode_parallax__")
    }
  })

  it("keeps the parallax skill compatibility entry point distinct from the parallax agent", () => {
    const skill = readFileSync(join(process.cwd(), "skills", "parallax", "SKILL.md"), "utf8")
    const agent = readFileSync(join(process.cwd(), "agents", "parallax.md"), "utf8")
    expect(skill).toMatch(/^name: parallax$/m)
    expect(skill).toContain("compatibility entry point")
    expect(agent).toMatch(/^name: parallax$/m)
    expect(skill).not.toContain("Unknown skill")
  })

  it("preserves installer scope without passing unsupported marketplace-update flags", () => {
    const installer = readFileSync(join(process.cwd(), "scripts", "install.mjs"), "utf8")
    expect(installer).toContain('["plugin", "update", "parallax-claudecode@parallax-local", "--scope", scope]')
    expect(installer).toContain('["plugin", "marketplace", "update", "parallax-local"]')
    expect(installer).not.toContain('["plugin", "marketplace", "update", "parallax-local", "--scope"')
  })

  it("allows a spaces-safe dry-run uninstall when dist is absent", () => {
    const root = join(tmpdir(), `parallax installer ${process.pid} ${Date.now()}`)
    mkdirSync(join(root, "scripts"), { recursive: true })
    cpSync(join(process.cwd(), "scripts", "install.mjs"), join(root, "scripts", "install.mjs"))
    try {
      const result = spawnSync(process.execPath, [join(root, "scripts", "install.mjs"), "uninstall", "--dry-run", "--scope", "user"], { cwd: root, encoding: "utf8" })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain("plugin uninstall")
      expect(result.stderr).not.toContain("dist is missing")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("keeps every manifest runtime target inside the explicit package allowlist", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      files: string[]
      main: string
      types: string
      bin: Record<string, string>
    }
    expect(manifest.files).toEqual(expect.arrayContaining(["dist", ".claude-plugin", "hooks", "skills", "agents"]))
    expect(manifest.files).not.toEqual(expect.arrayContaining(["src", "tests", ".parallax", "coverage"]))
    for (const target of [manifest.main, manifest.types, ...Object.values(manifest.bin)]) {
      expect(target).not.toMatch(/(?:^|[\\/])\.\.(?:[\\/]|$)/)
    }
  })

  it("packages effective least-privilege Horizon role frontmatter", () => {
    const supervisor = readFileSync(join(process.cwd(), "agents", "horizon.md"), "utf8")
    const worker = readFileSync(join(process.cwd(), "agents", "horizon-worker.md"), "utf8")
    const auditor = readFileSync(join(process.cwd(), "agents", "horizon-auditor.md"), "utf8")
    for (const text of [worker, auditor]) {
      expect(text).toMatch(/^---\nname: horizon-(?:worker|auditor)$/m)
      expect(text).toMatch(/^model: inherit$/m)
      expect(text).toMatch(/^maxTurns: \d+$/m)
      expect(text).toMatch(/^disallowedTools: /m)
      expect(text).not.toMatch(/^(?:hooks|mcpServers|permissionMode):/m)
    }
    const workerTools = worker.match(/^tools: (.+)$/m)![1]!.split(", ")
    expect(workerTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "Edit", "Write", "Bash", "mcp__plugin_parallax-claudecode_parallax__parallax_verify"]))
    expect(workerTools).not.toEqual(expect.arrayContaining(["Agent", "Task", "horizon_record_audit"]))
    const auditorTools = auditor.match(/^tools: (.+)$/m)![1]!.split(", ")
    expect(auditorTools).toEqual(expect.arrayContaining(["Read", "Glob", "Grep", "mcp__plugin_parallax-claudecode_parallax__horizon_read_plan"]))
    expect(auditorTools).not.toEqual(expect.arrayContaining(["Bash", "Edit", "Write", "Agent", "Task", "mcp__plugin_parallax-claudecode_parallax__parallax_verify"]))
    expect(supervisor.match(/^tools: (.+)$/m)![1]!.split(", ")).toEqual(expect.arrayContaining(["Agent", "mcp__plugin_parallax-claudecode_parallax__*"]))
    expect(supervisor).not.toContain("Agent(")
  })
})
