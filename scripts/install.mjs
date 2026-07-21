#!/usr/bin/env node
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let args = process.argv.slice(2)
const action = ["doctor", "status", "uninstall"].includes(args[0]) ? args.shift() : "install"
const allowedScopes = new Set(["user", "project", "local"])
let scope = "user"
let dryRun = false
let keepData = false

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === "--dry-run") {
    dryRun = true
  } else if (arg === "--json" && (action === "doctor" || action === "status")) {
    // Parsed by the doctor action below.
  } else if (arg === "--keep-data" && action === "uninstall") {
    keepData = true
  } else if (arg === "--scope") {
    scope = args[index + 1] ?? ""
    index += 1
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: parallax-claudecode [doctor|status [--json]|uninstall [--keep-data]] [--scope user|project|local] [--dry-run]")
    process.exit(0)
  } else {
    console.error(`[parallax] unknown argument: ${arg}`)
    process.exit(2)
  }
}

if (!allowedScopes.has(scope)) {
  console.error(`[parallax] invalid scope '${scope}'; expected user, project, or local`)
  process.exit(2)
}
if (action === "doctor" || action === "status") {
  const { formatDoctorMarkdown, runDoctor } = await import("../dist/doctor.js")
  try {
    const report = runDoctor({ packageRoot: root, projectRoot: process.cwd() })
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorMarkdown(report))
    process.exit(report.healthy ? 0 : 1)
  } catch {
    console.error(args.includes("--json") ? JSON.stringify({ schemaVersion: 1, healthy: false, error: "Doctor failed safely on malformed runtime or filesystem input." }) : "[parallax] doctor failed safely; reinstall the package and retry")
    process.exit(1)
  }
}

const executable = process.platform === "win32" ? "claude.exe" : "claude"
const workdir = process.env.INIT_CWD || process.cwd()
const display = (command) => ["claude", ...command].map((part) => /\s|["']/.test(part) ? JSON.stringify(part) : part).join(" ")
if (action === "uninstall") {
  const command = ["plugin", "uninstall", "parallax-claudecode@parallax-local", "--scope", scope, ...(keepData ? ["--keep-data"] : [])]
  if (dryRun) { console.log(`[parallax] would run: ${display(command)}`); process.exit(0) }
  const result = spawnSync(executable, command, { cwd: workdir, stdio: "inherit" })
  if (result.error?.code === "ENOENT") console.error("[parallax] Claude Code executable not found; install it or add it to PATH")
  process.exit(result.status ?? 1)
}
if (!existsSync(join(root, "dist", "mcp.js")) || !existsSync(join(root, "dist", "hook.js"))) {
  console.error("[parallax] dist is missing; run npm run build before local installation")
  process.exit(1)
}
const commands = [
  ["plugin", "marketplace", "add", root, "--scope", scope],
  ["plugin", "install", "parallax-claudecode@parallax-local", "--scope", scope],
]

console.log(`[parallax] plugin root: ${root}`)
console.log(`[parallax] install scope: ${scope}`)
if (dryRun) {
  for (const command of commands) console.log(`[parallax] would run: ${display(command)}`)
  console.log("[parallax] existing native registrations are updated in place; no settings files or plugin data are edited directly")
  process.exit(0)
}

function run(command) {
  return spawnSync(executable, command, { cwd: workdir, stdio: "inherit" })
}

let result = run(commands[0])
if (result.error?.code === "ENOENT") {
  console.error(`[parallax] Claude Code executable not found (home: ${homedir()}); install it or add it to PATH`)
  process.exit(1)
}
if ((result.status ?? 1) !== 0) {
  console.log("[parallax] marketplace add did not succeed; trying an update for an existing marketplace")
  // Claude's marketplace update has no --scope option; the existing registration
  // retains the scope selected when it was added.
  result = run(["plugin", "marketplace", "update", "parallax-local"])
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
}

result = run(commands[1])
if ((result.status ?? 1) !== 0) {
  console.log("[parallax] install did not succeed; trying an update for an existing plugin")
  result = run(["plugin", "update", "parallax-claudecode@parallax-local", "--scope", scope])
}
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
console.log("[parallax] installed. Restart Claude Code, then use /parallax-claudecode:status.")
