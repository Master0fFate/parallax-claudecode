import { readFileSync } from "node:fs"
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

  it("preserves installer scope without passing unsupported marketplace-update flags", () => {
    const installer = readFileSync(join(process.cwd(), "scripts", "install.mjs"), "utf8")
    expect(installer).toContain('["plugin", "update", "parallax-claudecode@parallax-local", "--scope", scope]')
    expect(installer).toContain('["plugin", "marketplace", "update", "parallax-local"]')
    expect(installer).not.toContain('["plugin", "marketplace", "update", "parallax-local", "--scope"')
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
})
