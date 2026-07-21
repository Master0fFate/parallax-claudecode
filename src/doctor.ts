import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { loadParallaxConfig } from "./config.js"
import {
  validateHorizonActiveChild, validateHorizonConfig, validateHorizonDecision, validateHorizonIndex,
  validateHorizonPlan, validateHorizonState, validateHorizonStateAgainstPlan,
} from "./horizon.js"
import { VerificationLedger } from "./ledger.js"
import { validateMutationQueueState } from "./mutation-queue.js"
import { sessionStorageKey, validateSessionState } from "./state.js"
import { PARALLAX_SCHEMA_VERSION } from "./types.js"

export const SUPPORTED_CLAUDE_RANGE = ">=2.1.215 <3"
export const SUPPORTED_NODE_RANGE = ">=20"
export type DoctorLevel = "pass" | "warn" | "fail"
export interface DoctorCheck { id: string; level: DoctorLevel; summary: string; remediation: string | null; details?: Record<string, unknown> }
export interface DoctorReport {
  schemaVersion: 1; healthy: boolean; generatedAt: string
  product: { name: string; version: string; claudeVersion: string | null; supportedClaude: string; nodeVersion: string; supportedNode: string }
  paths: { projectState: string; verificationLedger: string; ledgerArchive: string; horizonState: string }
  permissions: Record<string, { tools: string[]; disallowedTools: string[]; unsupportedFields: string[] }>
  checks: DoctorCheck[]
}
export interface DoctorCommandResult { status: number | null; stdout: string; stderr: string; errorCode?: string }
export interface DoctorOptions {
  root?: string; packageRoot?: string; projectRoot?: string; home?: string; now?: () => Date
  runClaude?: (args: string[]) => DoctorCommandResult; isWritable?: (path: string) => boolean
}

function readJson(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${basename(path)} must contain an object`)
  return value as Record<string, unknown>
}
function command(args: string[]): DoctorCommandResult {
  const result = spawnSync(process.platform === "win32" ? "claude.exe" : "claude", args, { encoding: "utf8", windowsHide: true })
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(errorCode ? { errorCode } : {}) }
}
function versionTuple(value: string): number[] | null { const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value); return match ? match.slice(1).map(Number) : null }
function supportedClaude(value: string | null): boolean { const p = value ? versionTuple(value) : null; return Boolean(p && p[0] === 2 && (p[1]! > 1 || (p[1] === 1 && p[2]! >= 215))) }
function frontmatter(path: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(path, "utf8"))
  if (!match) throw new Error("frontmatter missing")
  const values: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) { const index = line.indexOf(":"); if (index > 0) values[line.slice(0, index).trim()] = line.slice(index + 1).trim() }
  return values
}
function list(value: string | undefined): string[] { return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [] }
function writable(path: string): boolean { let candidate = path; while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate); try { accessSync(candidate, constants.W_OK); return true } catch { return false } }
function parseArray(result: DoctorCommandResult): { value: Record<string, unknown>[] | null; reason: string | null } {
  if (result.errorCode) return { value: null, reason: result.errorCode === "ENOENT" ? "command-unavailable" : "command-error" }
  if (result.status !== 0) return { value: null, reason: "nonzero-exit" }
  try { const value: unknown = JSON.parse(result.stdout); return Array.isArray(value) && value.every((item) => item && typeof item === "object" && !Array.isArray(item)) ? { value: value as Record<string, unknown>[], reason: null } : { value: null, reason: "malformed-output" } } catch { return { value: null, reason: "malformed-output" } }
}
function entries(path: string, directories: boolean): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path, { withFileTypes: true }).filter((entry) => directories ? entry.isDirectory() : entry.isFile()).map((entry) => entry.name).sort()
}
function lockAge(path: string): boolean { try { return Date.now() - statSync(path).mtimeMs > 30_000 } catch { return true } }

function inspectProjectStorage(root: string): { invalidSessions: number; missingSessionState: number; queueErrors: number; missingQueues: number; locks: number; staleLocks: number } {
  let invalidSessions = 0; let missingSessionState = 0; let queueErrors = 0; let missingQueues = 0; let locks = 0; let staleLocks = 0
  const sessions = join(root, ".parallax", "sessions")
  try { for (const entry of existsSync(sessions) ? readdirSync(sessions, { withFileTypes: true }) : []) {
    const path = join(sessions, entry.name)
    if (entry.isDirectory() && entry.name.endsWith(".lock")) { locks += 1; if (lockAge(path)) staleLocks += 1; continue }
    if (!entry.isDirectory()) { invalidSessions += 1; continue }
    const statePath = join(path, "state.json")
    if (!existsSync(statePath)) { missingSessionState += 1; continue }
    try { const state = validateSessionState(JSON.parse(readFileSync(statePath, "utf8"))); if (sessionStorageKey(state.sessionId) !== entry.name) throw new Error("storage key mismatch") } catch { invalidSessions += 1 }
  } } catch { invalidSessions += 1 }
  const queues = join(root, ".parallax", "mutation-intents")
  try { for (const entry of existsSync(queues) ? readdirSync(queues, { withFileTypes: true }) : []) {
    const path = join(queues, entry.name)
    if (entry.isDirectory() && entry.name.endsWith(".lock")) { locks += 1; if (lockAge(path)) staleLocks += 1; continue }
    if (!entry.isDirectory()) { queueErrors += 1; continue }
    const queuePath = join(path, "queue.json")
    if (!existsSync(queuePath)) { missingQueues += 1; continue }
    try { const queue = validateMutationQueueState(JSON.parse(readFileSync(queuePath, "utf8")), resolve(root)); if (sessionStorageKey(queue.sessionId) !== entry.name) throw new Error("storage key mismatch") } catch { queueErrors += 1 }
  } } catch { queueErrors += 1 }
  return { invalidSessions, missingSessionState, queueErrors, missingQueues, locks, staleLocks }
}

function inspectHorizon(root: string): { errors: number; sessions: number; locks: number; staleLocks: number } {
  let errors = 0; let locks = 0; let staleLocks = 0
  if (!existsSync(root)) return { errors, sessions: 0, locks, staleLocks }
  try { if (existsSync(join(root, "config.json"))) validateHorizonConfig(JSON.parse(readFileSync(join(root, "config.json"), "utf8"))) } catch { errors += 1 }
  let index: ReturnType<typeof validateHorizonIndex> | null = null
  try { if (existsSync(join(root, "index.json"))) index = validateHorizonIndex(JSON.parse(readFileSync(join(root, "index.json"), "utf8"))) } catch { errors += 1 }
  const sessionRoot = join(root, "sessions"); const ids = entries(sessionRoot, true)
  if (ids.length && !index) errors += 1
  if (index && JSON.stringify(Object.keys(index.sessions).sort()) !== JSON.stringify(ids)) errors += 1
  for (const id of ids) {
    try {
      const plan = validateHorizonPlan(JSON.parse(readFileSync(join(sessionRoot, id, "plan.json"), "utf8")), id)
      const state = validateHorizonState(JSON.parse(readFileSync(join(sessionRoot, id, "state.json"), "utf8")), id)
      validateHorizonStateAgainstPlan(state, plan)
      const decisions = readFileSync(join(sessionRoot, id, "decisions.jsonl"), "utf8").split("\n").filter(Boolean)
      decisions.forEach((line) => validateHorizonDecision(JSON.parse(line)))
      if (existsSync(join(sessionRoot, id, "active-child.json"))) validateHorizonActiveChild(JSON.parse(readFileSync(join(sessionRoot, id, "active-child.json"), "utf8")), resolve(root), id)
    } catch { errors += 1 }
  }
  try { for (const name of entries(join(root, ".locks"), true)) { if (!name.endsWith(".lock")) { errors += 1; continue }; locks += 1; if (lockAge(join(root, ".locks", name))) staleLocks += 1 } } catch { errors += 1 }
  return { errors, sessions: ids.length, locks, staleLocks }
}

function runtimeToolNames(path: string): string[] {
  const text = readFileSync(path, "utf8")
  return [...new Set([...text.matchAll(/(?:name:\s*|modeTool\()\"((?:parallax|horizon)_[a-z0-9_]+)\"/g)].map((match) => match[1]!))].sort()
}

export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const packageRoot = resolve(options.packageRoot ?? options.root ?? process.cwd())
  const projectRoot = resolve(options.projectRoot ?? options.root ?? process.cwd())
  const home = resolve(options.home ?? homedir()); const horizonRoot = join(home, ".parallax", "horizon")
  const runClaude = options.runClaude ?? command; const isWritable = options.isWritable ?? writable; const checks: DoctorCheck[] = []
  const add = (id: string, level: DoctorLevel, summary: string, remediation: string | null = null, details?: Record<string, unknown>): void => { checks.push({ id, level, summary, remediation, ...(details ? { details } : {}) }) }
  let pkg: Record<string, unknown> = {}; let plugin: Record<string, unknown> = {}; let marketplace: Record<string, unknown> = {}; let metadataError = false
  try { pkg = readJson(join(packageRoot, "package.json")); plugin = readJson(join(packageRoot, ".claude-plugin", "plugin.json")); marketplace = readJson(join(packageRoot, ".claude-plugin", "marketplace.json")) } catch { metadataError = true }
  const listing = Array.isArray(marketplace.plugins) ? (marketplace.plugins as Record<string, unknown>[]).find((item) => item.name === pkg.name) : undefined
  const metadataOkay = !metadataError && typeof pkg.name === "string" && typeof pkg.version === "string" && plugin.name === pkg.name && plugin.version === pkg.version && listing?.version === pkg.version
  add("metadata", metadataOkay ? "pass" : "fail", metadataOkay ? `Package, plugin, and marketplace agree on ${pkg.version}.` : "Package/plugin metadata is missing, malformed, or inconsistent.", metadataOkay ? null : "Reinstall a complete package with synchronized metadata.")

  let versionResult: DoctorCommandResult
  try { versionResult = runClaude(["--version"]) } catch { versionResult = { status: null, stdout: "", stderr: "", errorCode: "CALL_FAILED" } }
  const claudeVersion = versionResult.status === 0 && !versionResult.errorCode ? versionResult.stdout.trim() : null
  const claudeOkay = supportedClaude(claudeVersion)
  const versionReason = versionResult.errorCode === "ENOENT" ? "command-unavailable" : versionResult.errorCode ? "command-error" : versionResult.status !== 0 ? "nonzero-exit" : claudeVersion ? "unsupported-version" : "malformed-output"
  add("claude-version", claudeOkay ? "pass" : "fail", claudeOkay ? `Claude Code ${claudeVersion} (tested ${SUPPORTED_CLAUDE_RANGE}).` : `Claude Code check failed (${versionReason}).`, claudeOkay ? null : `Install a Claude Code version in the tested range ${SUPPORTED_CLAUDE_RANGE}.`, claudeOkay ? undefined : { diagnostic: versionReason, status: versionResult.status })
  const nodeMajor = Number(process.versions.node.split(".")[0]); add("node-version", nodeMajor >= 20 ? "pass" : "fail", `Node ${process.versions.node} (supported ${SUPPORTED_NODE_RANGE}).`, nodeMajor >= 20 ? null : "Install Node.js 20 or newer.")

  let installedResult: DoctorCommandResult; let marketplaceResult: DoctorCommandResult
  try { installedResult = runClaude(["plugin", "list", "--json"]) } catch { installedResult = { status: null, stdout: "", stderr: "", errorCode: "CALL_FAILED" } }
  try { marketplaceResult = runClaude(["plugin", "marketplace", "list", "--json"]) } catch { marketplaceResult = { status: null, stdout: "", stderr: "", errorCode: "CALL_FAILED" } }
  const installed = parseArray(installedResult); const marketplaces = parseArray(marketplaceResult)
  const installedEntry = installed.value?.find((item) => item.id === "parallax-claudecode@parallax-local"); const marketplaceEntry = marketplaces.value?.find((item) => item.name === "parallax-local")
  const registered = Boolean(installedEntry && marketplaceEntry); const stale = Boolean(registered && installedEntry?.version !== pkg.version); const disabled = installedEntry?.enabled === false; const registrationOkay = registered && !stale && !disabled
  const registrationReason = installed.reason ?? marketplaces.reason ?? (!registered ? "registration-missing" : stale ? "version-mismatch" : disabled ? "plugin-disabled" : null)
  add("native-registration", registrationOkay ? "pass" : "fail", registrationOkay ? "Native marketplace and plugin registration were discovered." : `Native registration is unhealthy (${registrationReason}).`, registrationOkay ? null : "Run parallax-claudecode --scope user to install or update through Claude's native plugin commands.", { diagnostic: registrationReason, installedVersion: installedEntry?.version ?? null, packageVersion: typeof pkg.version === "string" ? pkg.version : null, enabled: installedEntry?.enabled ?? null })

  const required = ["hooks/hooks.json", ".mcp.json", "dist/hook.js", "dist/mcp.js", "dist/doctor.js", "dist/horizon-dispatch.js", "dist/ledger.js", "dist/mutation-queue.js"]
  const missing = required.filter((path) => !existsSync(join(packageRoot, path)))
  let inventoryErrors = 0; let hookEvents: string[] = []; let agentNames: string[] = []; let skillNames: string[] = []; let toolNames: string[] = []
  try {
    const hooks = readJson(join(packageRoot, "hooks", "hooks.json")).hooks
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("invalid hooks")
    hookEvents = Object.keys(hooks as Record<string, unknown>).sort()
    for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
      if (!Array.isArray(groups) || !groups.length || groups.some((group) => !group || typeof group !== "object" || !Array.isArray((group as Record<string, unknown>).hooks)
        || ((group as Record<string, unknown>).hooks as unknown[]).some((hook) => !hook || typeof hook !== "object" || !Array.isArray((hook as Record<string, unknown>).args) || !((hook as Record<string, unknown>).args as unknown[]).includes(event)))) inventoryErrors += 1
    }
  } catch { inventoryErrors += 1 }
  try { agentNames = entries(join(packageRoot, "agents"), false).filter((name) => name.endsWith(".md")).map((name) => { const expected = name.slice(0, -3); if (frontmatter(join(packageRoot, "agents", name)).name !== expected) throw new Error("agent name mismatch"); return expected }) } catch { inventoryErrors += 1 }
  try { skillNames = entries(join(packageRoot, "skills"), true).map((name) => { if (frontmatter(join(packageRoot, "skills", name, "SKILL.md")).name !== name) throw new Error("skill name mismatch"); return name }) } catch { inventoryErrors += 1 }
  try { toolNames = runtimeToolNames(join(packageRoot, "dist", "mcp.js")); if (!toolNames.length) throw new Error("no tools") } catch { inventoryErrors += 1 }
  const assetsOkay = missing.length === 0 && inventoryErrors === 0
  add("runtime-inventory", assetsOkay ? "pass" : "fail", assetsOkay ? `Packed runtime exposes ${hookEvents.length} hook events, ${toolNames.length} MCP tools, ${skillNames.length} skills, and ${agentNames.length} agents.` : "Packed runtime assets are missing, malformed, or incomplete.", assetsOkay ? null : "Reinstall the package or build and repack a complete checkout.", { missing, hookEvents, toolCount: toolNames.length, toolNames, skills: skillNames, agents: agentNames, inventoryErrors })

  const permissions: DoctorReport["permissions"] = {}
  for (const role of ["horizon-worker", "horizon-auditor"]) {
    try { const values = frontmatter(join(packageRoot, "agents", `${role}.md`)); permissions[role] = { tools: list(values.tools), disallowedTools: list(values.disallowedTools), unsupportedFields: ["hooks", "mcpServers", "permissionMode"].filter((field) => values[field] !== undefined) } } catch { permissions[role] = { tools: [], disallowedTools: [], unsupportedFields: ["malformed-frontmatter"] } }
  }
  const worker = permissions["horizon-worker"]!; const auditor = permissions["horizon-auditor"]!
  const permissionOkay = worker.unsupportedFields.length === 0 && auditor.unsupportedFields.length === 0 && !worker.tools.includes("Agent") && !auditor.tools.some((tool) => ["Bash", "Edit", "Write", "Agent", "Task"].includes(tool))
  add("role-permissions", permissionOkay ? "pass" : "fail", permissionOkay ? "Worker and auditor permissions are explicit and supported." : "Role permission declarations are missing, malformed, unsafe, or unsupported.", permissionOkay ? null : "Restore the documented least-privilege role frontmatter.")

  let configOkay = true; let configSummary = "Defaults are active; no project config exists."; const configPath = join(projectRoot, ".parallax", "config.json")
  try { const config = loadParallaxConfig(projectRoot); if (existsSync(configPath)) configSummary = `Project config is valid (strictness: ${config.strictness}).` } catch { configOkay = false; configSummary = "Project config is missing required structure, malformed, or invalid." }
  add("config", configOkay ? "pass" : "fail", configSummary, configOkay ? null : "Correct or remove <project>/.parallax/config.json.", { source: existsSync(configPath) ? "project" : "defaults" })
  const stateWritable = isWritable(join(projectRoot, ".parallax")); const horizonWritable = isWritable(horizonRoot)
  add("path-writeability", stateWritable && horizonWritable ? "pass" : "fail", stateWritable && horizonWritable ? "Canonical project and Horizon state parents are writable." : "A canonical state parent is not writable.", stateWritable && horizonWritable ? null : "Fix ownership/permissions for <project>/.parallax or ~/.parallax/horizon.", { project: stateWritable, horizon: horizonWritable })

  const stored = inspectProjectStorage(projectRoot); const horizon = inspectHorizon(horizonRoot)
  let ledgerValid = true; let archiveIssues = 0
  try { const diagnostic = new VerificationLedger(projectRoot).diagnostics(); ledgerValid = diagnostic.canonicalValid; archiveIssues = diagnostic.invalidManifests.length + diagnostic.archives.filter((item) => !item.byteEqualityVerified).length } catch { ledgerValid = false }
  const storageOkay = Object.entries(stored).every(([key, value]) => key === "locks" || value === 0) && horizon.errors === 0 && horizon.staleLocks === 0 && ledgerValid && archiveIssues === 0
  add("storage-health", storageOkay ? "pass" : "fail", storageOkay ? `State schema ${PARALLAX_SCHEMA_VERSION}, project/Horizon state, ledger, archives, locks, and queues are healthy.` : "Missing, stale, incompatible, or corrupt project/Horizon state was found.", storageOkay ? null : "Use docs/TROUBLESHOOTING.md recovery steps; preserve evidence before replacing state.", { ...stored, horizon, ledgerValid, archiveIssues, schemaVersion: PARALLAX_SCHEMA_VERSION })
  return { schemaVersion: 1, healthy: checks.every((item) => item.level !== "fail"), generatedAt: (options.now ?? (() => new Date()))().toISOString(), product: { name: typeof pkg.name === "string" ? pkg.name : "parallax-claudecode", version: typeof pkg.version === "string" ? pkg.version : "unknown", claudeVersion, supportedClaude: SUPPORTED_CLAUDE_RANGE, nodeVersion: process.versions.node, supportedNode: SUPPORTED_NODE_RANGE }, paths: { projectState: "<project>/.parallax/sessions", verificationLedger: "<project>/.parallax/verification-ledger.jsonl", ledgerArchive: "<project>/.parallax/ledger-archive", horizonState: "~/.parallax/horizon/sessions" }, permissions, checks }
}

export function formatDoctorMarkdown(report: DoctorReport): string {
  const lines = ["## Parallax Doctor", "", `**Verdict:** ${report.healthy ? "HEALTHY" : "UNHEALTHY"}`, `**Package:** ${report.product.name} ${report.product.version}`, `**Claude Code:** ${report.product.claudeVersion ?? "not found"} (tested ${report.product.supportedClaude})`, `**Node:** ${report.product.nodeVersion} (supported ${report.product.supportedNode})`, "", "### Checks"]
  for (const check of report.checks) { lines.push(`- **${check.level.toUpperCase()} — ${check.id}:** ${check.summary}`); if (check.remediation) lines.push(`  - Remediation: ${check.remediation}`) }
  lines.push("", "### Canonical storage", ...Object.entries(report.paths).map(([name, path]) => `- **${name}:** \`${path}\``)); return lines.join("\n")
}
