#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const npmArgs = ["pack", "--dry-run", "--json"]
const npmCli = process.env.npm_execpath
const result = npmCli
  ? spawnSync(process.execPath, [npmCli, ...npmArgs], { cwd: root, encoding: "utf8" })
  : spawnSync("npm", npmArgs, { cwd: root, encoding: "utf8", shell: process.platform === "win32" })
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout || String(result.error ?? "npm pack failed"))
  process.exit(result.status ?? 1)
}

let report
try {
  report = JSON.parse(result.stdout)[0]
} catch {
  console.error("[package] npm pack did not return parseable JSON")
  process.exit(1)
}
const files = new Set(report.files.map((entry) => entry.path.replaceAll("\\", "/")))
const required = [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".mcp.json",
  "hooks/hooks.json",
  ...readdirSync(join(root, "agents"), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => `agents/${entry.name}`),
  "commands/parallax-status.md",
  "dist/hook.js",
  "dist/mcp.js",
  "dist/doctor.js",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "docs/ARCHITECTURE.md",
  "docs/MIGRATION.md",
  "docs/TROUBLESHOOTING.md",
  "examples/check-in.md",
  "examples/horizon-goal.md",
  "examples/hyperplan.md",
  "scripts/install.mjs",
  "scripts/dev.mjs",
  "scripts/verify-package.mjs",
  "scripts/release-proof.mjs",
  "scripts/doctor.mjs",
  ...readdirSync(join(root, "skills"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `skills/${entry.name}/SKILL.md`),
]
const missing = required.filter((path) => !files.has(path))
if (missing.length > 0) {
  console.error(`[package] missing packed assets:\n${missing.map((path) => `  - ${path}`).join("\n")}`)
  process.exit(1)
}

const forbidden = [...files].filter((path) =>
  /^(?:src|tests|coverage|\.github|\.parallax|node_modules)(?:\/|$)/.test(path)
  || /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|state\.json|decisions\.jsonl)$/.test(path),
)
if (forbidden.length > 0) {
  console.error(`[package] forbidden development or state assets:\n${forbidden.map((path) => `  - ${path}`).join("\n")}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"))
const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf8"))
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))
const listing = marketplace.plugins?.find((entry) => entry.name === manifest.name)
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(report.integrity ?? "") || !/^[a-f0-9]{40}$/.test(report.shasum ?? "")) {
  console.error("[package] npm archive integrity metadata is missing or malformed")
  process.exit(1)
}
if (!manifest.author || !manifest.license || !manifest.repository?.url) {
  console.error("[package] package ownership metadata (author, license, repository) is incomplete")
  process.exit(1)
}
const unsafeModes = report.files.filter((entry) => typeof entry.mode !== "number" || (entry.mode & 0o022) !== 0)
if (unsafeModes.length > 0) {
  console.error(`[package] archive entries are group/world writable or have unknown ownership mode:\n${unsafeModes.map((entry) => `  - ${entry.path}`).join("\n")}`)
  process.exit(1)
}
if (plugin.name !== manifest.name || plugin.version !== manifest.version || listing?.version !== manifest.version || lock.version !== manifest.version || lock.packages?.[""]?.version !== manifest.version) {
  console.error("[package] package, lockfile, plugin, and marketplace name/version metadata must match")
  process.exit(1)
}
const orderedEntries = (value) => Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right))
if (JSON.stringify(orderedEntries(lock.packages?.[""]?.bin)) !== JSON.stringify(orderedEntries(manifest.bin)) || lock.packages?.[""]?.engines?.node !== manifest.engines?.node) {
  console.error("[package] lockfile bin or engine metadata does not match package.json")
  process.exit(1)
}
const runtimeVersions = {
  "dist/trace.js": `const AGENT_VERSION = \"${manifest.version}\"`,
  "dist/mcp.js": `serverInfo: { name: \"parallax-claudecode\", version: \"${manifest.version}\" }`,
}
for (const [runtime, marker] of Object.entries(runtimeVersions)) {
  if (!readFileSync(join(root, runtime), "utf8").includes(marker)) {
    console.error(`[package] runtime version is inconsistent: ${runtime}`)
    process.exit(1)
  }
}
for (const agentName of required.filter((entry) => entry.startsWith("agents/")).map((entry) => entry.slice(7, -3))) {
  const agent = readFileSync(join(root, "agents", `${agentName}.md`), "utf8")
  if (!new RegExp(`^name: ${agentName}$`, "m").test(agent)) {
    console.error(`[package] agent frontmatter name is inconsistent: ${agentName}`)
    process.exit(1)
  }
}
for (const target of [manifest.main, manifest.types, ...Object.values(manifest.bin ?? {})]) {
  const normalized = String(target).replace(/^\.\//, "")
  if (!files.has(normalized)) {
    console.error(`[package] manifest target is absent from tarball: ${target}`)
    process.exit(1)
  }
}

for (const path of required.filter((entry) => entry.startsWith("skills/"))) {
  const text = readFileSync(join(root, path), "utf8")
  const expected = path.split("/")[1]
  if (!text.startsWith("---\n") || !new RegExp(`^name: ${expected}$`, "m").test(text)) {
    console.error(`[package] invalid or mismatched skill frontmatter: ${path}`)
    process.exit(1)
  }
}

console.log(`[package] verified ${required.length} required assets in ${report.filename} (${report.size} bytes)`)
