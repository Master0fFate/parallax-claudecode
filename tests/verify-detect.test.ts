import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { detectProject, getVerifyCommands, runVerification } from "../src/index.js"
import type { ProjectDetection, VerifyCommand } from "../src/types.js"
import { TestWorkspace } from "./fixtures.js"

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
function nodeCommand(source: string, label: string): VerifyCommand {
  return { command: process.execPath, args: ["-e", source], label }
}

describe("project detection matrix", () => {
  it.each([
    ["Cargo.toml", "cargo"],
    ["go.mod", "go"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["Directory.Build.props", "dotnet"],
  ] as const)("detects %s as %s", (marker, type) => {
    const root = workspace(type).root
    writeFileSync(join(root, marker), "")
    expect(detectProject(root).type).toBe(type)
  })

  it.each([
    ["pnpm-lock.yaml", "pnpm", ["run", "check"]],
    ["yarn.lock", "yarn", ["check"]],
    ["bun.lockb", "bun", ["run", "check"]],
  ] as const)("uses the %s lockfile without shell command construction", (lockfile, manager, args) => {
    const root = workspace(manager).root
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { check: "tool --flag" } }))
    writeFileSync(join(root, lockfile), "")
    const detected = detectProject(root)
    expect(detected.packageManager).toBe(manager)
    expect(getVerifyCommands(detected)).toEqual([{ command: manager, args, label: `${manager} ${args.join(" ")}` }])
  })

  it("prefers check, filters the npm placeholder, and falls back to build", () => {
    const root = workspace("script-selection").root
    const manifest = join(root, "package.json")
    writeFileSync(manifest, JSON.stringify({ scripts: { check: "one", typecheck: "two", test: "three" } }))
    expect(getVerifyCommands(detectProject(root))).toHaveLength(1)

    writeFileSync(manifest, JSON.stringify({ scripts: { test: "echo Error: no test specified && exit 1", build: "tsc" } }))
    expect(getVerifyCommands(detectProject(root))[0]).toMatchObject({ args: ["run", "build"] })

    writeFileSync(manifest, "not json")
    expect(getVerifyCommands(detectProject(root))).toEqual([])
  })

  it("selects the nearest project marker", () => {
    const outer = workspace("monorepo").root
    const inner = join(outer, "packages", "child")
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, "package.json"), "{}")
    writeFileSync(join(inner, "go.mod"), "")
    expect(detectProject(inner)).toMatchObject({ type: "go", root: inner })
  })
})

describe("verification execution", () => {
  it("runs all checks in order, deduplicates file evidence, and captures output", async () => {
    const root = workspace("verify-pass").root
    const commands = [
      nodeCommand("process.stdout.write('first')", "first"),
      nodeCommand("process.stdout.write('second')", "second"),
    ]
    const result = await runVerification(project(root), ["a.ts", "a.ts", "b.ts"], { thorough: true, commands })
    expect(result).toMatchObject({ verdict: "pass", exitCode: 0, command: "first && second", files: ["a.ts", "b.ts"] })
    expect(result.stdout).toContain("first")
    expect(result.stdout).toContain("second")
  })

  it("stops after the first failing command", async () => {
    const root = workspace("verify-fail").root
    const marker = join(root, "must-not-exist")
    const commands = [
      nodeCommand("process.stderr.write('expected failure'); process.exit(7)", "fail"),
      nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`, "unsafe-next"),
    ]
    const result = await runVerification(project(root), [], { thorough: true, commands })
    expect(result).toMatchObject({ verdict: "fail", exitCode: 7, command: "fail" })
    expect(result.stderr).toContain("expected failure")
  })

  it("times out and cancels commands without invoking a shell", async () => {
    const root = workspace("verify-timeout").root
    const timeout = await runVerification(project(root), [], {
      timeoutMs: 50,
      commands: [nodeCommand("setTimeout(() => {}, 10000)", "slow")],
    })
    expect(timeout.verdict).toBe("fail")
    expect(timeout.stderr).toContain("timed out")

    const controller = new AbortController()
    controller.abort()
    const cancelled = await runVerification(project(root), [], {
      signal: controller.signal,
      commands: [nodeCommand("setTimeout(() => {}, 10000)", "cancel")],
    })
    expect(cancelled.stderr).toContain("cancelled")
  })

  it("returns an explicit skipped record when no command is available", async () => {
    const root = workspace("verify-skip").root
    const result = await runVerification({ type: null, root, markers: [], packageManager: null }, ["x.ts"])
    expect(result).toMatchObject({ verdict: "skipped", command: null, exitCode: null, files: ["x.ts"] })
    expect(result.stderr).toContain("No supported")
  })
})
