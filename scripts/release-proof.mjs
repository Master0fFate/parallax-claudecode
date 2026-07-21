#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import { gunzipSync } from "node:zlib"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MAX_CAPTURE = 256 * 1024
const AUDIT_LEVEL = "high"
const AUDIT_SEVERITIES = ["info", "low", "moderate", "high", "critical"]

export function redact(value) {
  return String(value ?? "")
    .replace(/\b(?:sk-ant-|sk-|xox[baprs]-|gh[pousr]_)[A-Za-z0-9_\-]{8,}\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|authorization|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(-MAX_CAPTURE)
}

export function parseJsonLines(text) {
  return String(text).split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function octal(buffer, start, length) {
  const raw = buffer.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "").trim()
  return raw ? Number.parseInt(raw, 8) : 0
}

export function parseTar(gzip) {
  const buffer = gunzipSync(gzip)
  const entries = []
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "")
    const name = `${text(345, 155) ? `${text(345, 155)}/` : ""}${text(0, 100)}`.replaceAll("\\", "/")
    const size = octal(header, 124, 12)
    const mode = octal(header, 100, 8)
    const type = text(156, 1) || "0"
    const start = offset + 512
    entries.push({ name, size, mode, type, data: buffer.subarray(start, start + size) })
    offset = start + Math.ceil(size / 512) * 512
  }
  return entries
}

export function archiveProblems(entries, manifest) {
  const roots = new Set(["package.json", ...manifest.files.map((item) => item.replace(/^\.\//, "").replaceAll("\\", "/"))])
  const forbidden = /^(?:src|tests|coverage|\.github|\.parallax|node_modules)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|state\.json|decisions\.jsonl|release-proof\/)/
  const problems = []
  for (const entry of entries) {
    if (!entry.name.startsWith("package/")) { problems.push(`entry outside package/: ${entry.name}`); continue }
    const path = entry.name.slice(8).replace(/\/$/, "")
    if (!path) continue
    if (path.includes("../") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) problems.push(`unsafe path: ${path}`)
    if (!["0", "5"].includes(entry.type)) problems.push(`unsupported archive type ${entry.type}: ${path}`)
    if ((entry.mode & 0o022) !== 0) problems.push(`group/world writable mode: ${path}`)
    if (forbidden.test(path)) problems.push(`forbidden asset: ${path}`)
    if (![...roots].some((allowed) => path === allowed || path.startsWith(`${allowed}/`))) problems.push(`outside allowlist: ${path}`)
  }
  return problems
}

export function computeReportVerdict(checks) {
  const applicable = checks.filter((check) => check.applicable !== false)
  const failed = applicable.some((check) => check.verdict !== "pass")
  return {
    verdict: failed ? "fail" : "pass",
    publishable: !failed,
  }
}

export function parseAuditReport(text, auditLevel = AUDIT_LEVEL) {
  if (!AUDIT_SEVERITIES.includes(auditLevel)) throw new Error(`Unsupported npm audit level: ${auditLevel}`)
  let report
  try { report = JSON.parse(String(text)) } catch { throw new Error("npm audit emitted malformed JSON") }
  const counts = report?.metadata?.vulnerabilities
  if (!counts || AUDIT_SEVERITIES.some((severity) => !Number.isSafeInteger(counts[severity]) || counts[severity] < 0) || !Number.isSafeInteger(counts.total) || counts.total < 0) {
    throw new Error("npm audit JSON omitted valid vulnerability counts")
  }
  const countedTotal = AUDIT_SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0)
  if (countedTotal !== counts.total) throw new Error("npm audit vulnerability totals are inconsistent")
  const threshold = AUDIT_SEVERITIES.indexOf(auditLevel)
  const applicable = AUDIT_SEVERITIES.slice(threshold).reduce((sum, severity) => sum + counts[severity], 0)
  return { auditLevel, counts: Object.fromEntries(AUDIT_SEVERITIES.map((severity) => [severity, counts[severity]])), total: counts.total, applicable }
}

export function parseRoleFrontmatter(text) {
  const frontmatter = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatter) throw new Error("Role frontmatter is missing")
  const fields = Object.fromEntries(frontmatter[1].split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Za-z]+):\s*(.*)$/)
    return match ? [[match[1], match[2]]] : []
  }))
  const list = (name) => String(fields[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean)
  return { tools: list("tools"), disallowedTools: list("disallowedTools") }
}

export function roleBoundaryProblems(workerText, auditorText) {
  const worker = parseRoleFrontmatter(workerText); const auditor = parseRoleFrontmatter(auditorText)
  const problems = []
  const requireAllowed = (role, actual, required) => { for (const tool of required) if (!actual.includes(tool)) problems.push(`${role} missing required allowed capability: ${tool}`) }
  const requireForbidden = (role, config, forbidden) => { for (const tool of forbidden) if (config.tools.includes(tool) || !config.disallowedTools.includes(tool)) problems.push(`${role} forbidden capability is not explicit: ${tool}`) }
  requireAllowed("worker", worker.tools, ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "mcp__plugin_parallax-claudecode_parallax__parallax_checkin", "mcp__plugin_parallax-claudecode_parallax__parallax_verify", "mcp__plugin_parallax-claudecode_parallax__parallax_trace_export"])
  requireForbidden("worker", worker, ["Agent", "Task"])
  for (const tool of worker.tools) if (/Agent|Task|horizon_|record_audit|observe_receipt/i.test(tool)) problems.push(`worker exposes audit/orchestration capability: ${tool}`)
  requireAllowed("auditor", auditor.tools, ["Read", "Glob", "Grep", "mcp__plugin_parallax-claudecode_parallax__horizon_read_plan", "mcp__plugin_parallax-claudecode_parallax__horizon_read_state", "mcp__plugin_parallax-claudecode_parallax__horizon_active_child", "mcp__plugin_parallax-claudecode_parallax__parallax_trace_view"])
  requireForbidden("auditor", auditor, ["Write", "Edit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "mcp__plugin_parallax-claudecode_parallax__parallax_verify", "mcp__plugin_parallax-claudecode_parallax__parallax_checkin", "mcp__plugin_parallax-claudecode_parallax__horizon_record_audit"])
  const auditorReadMcp = new Set(["mcp__plugin_parallax-claudecode_parallax__horizon_read_plan", "mcp__plugin_parallax-claudecode_parallax__horizon_read_state", "mcp__plugin_parallax-claudecode_parallax__horizon_active_child", "mcp__plugin_parallax-claudecode_parallax__parallax_trace_view"])
  for (const tool of auditor.tools) if (tool.startsWith("mcp__") && !auditorReadMcp.has(tool)) problems.push(`auditor exposes non-read-only MCP capability: ${tool}`)
  return problems
}

export function terminateWindowsProcessTree(pid, options = {}) {
  const spawnProcess = options.spawnProcess ?? spawn; const timeoutMs = options.timeoutMs ?? 2_000
  return new Promise((resolveTermination) => {
    let settled = false
    const killer = spawnProcess("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolveTermination(result) }
    const timer = setTimeout(() => { try { killer.kill?.("SIGKILL") } catch {}; finish("timeout") }, timeoutMs)
    timer.unref?.()
    killer.once("close", () => finish("closed")); killer.once("error", () => finish("error"))
  })
}

async function terminate(child) {
  if (!child.pid) return
  if (process.platform === "win32") await terminateWindowsProcessTree(child.pid)
  else { try { process.kill(-child.pid, "SIGKILL") } catch { try { child.kill("SIGKILL") } catch {} } }
}

export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""; let stderr = ""; let timedOut = false; let settled = false; let cleanup = Promise.resolve()
    const append = (current, chunk) => (current + chunk).slice(-MAX_CAPTURE)
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk) })
    child.on("error", (error) => { stderr = append(stderr, error.message) })
    if (options.input) child.stdin.end(options.input); else child.stdin.end()
    const finish = (code, signal) => {
      if (settled) return; settled = true
      clearTimeout(timer)
      resolveRun({ code, signal, timedOut, stdout: redact(stdout), stderr: redact(stderr) })
    }
    const timer = setTimeout(async () => { timedOut = true; cleanup = terminate(child); await cleanup; finish(null, null) }, timeoutMs)
    child.on("close", async (code, signal) => { await cleanup; finish(code, signal) })
  })
}

function extract(entries, target) {
  for (const entry of entries) {
    const path = entry.name.slice(8).replaceAll("/", sep)
    if (!path) continue
    const destination = resolve(target, path)
    if (destination !== target && !destination.startsWith(`${target}${sep}`)) throw new Error(`Archive traversal: ${entry.name}`)
    if (entry.type === "5") mkdirSync(destination, { recursive: true })
    else if (entry.type === "0") { mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, entry.data, { mode: entry.mode & 0o777 }) }
  }
}

function isolatedEnv(work, project, config, useAuth) {
  const names = process.platform === "win32"
    ? ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]
    : ["PATH", "TMPDIR", "LANG", "LC_ALL"]
  const env = Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  if (useAuth) for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return { ...env, HOME: config, USERPROFILE: config, CLAUDE_CONFIG_DIR: config, CLAUDE_PROJECT_DIR: project, PARALLAX_PROJECT_ROOT: project, PARALLAX_HORIZON_HOME: join(work, "horizon state"), CI: "1", NO_COLOR: "1" }
}

function checkRecord(id, classification, verdict, detail, extra = {}) {
  return { id, classification, applicable: true, verdict, detail: redact(detail).slice(0, 4096), ...extra }
}

function request(id, method, params = {}) { return JSON.stringify({ jsonrpc: "2.0", id, method, params }) }

function npmInvocation(args) {
  return process.env.npm_execpath ? [process.execPath, [process.env.npm_execpath, ...args]] : ["npm", args]
}

function horizonPlan(sessionId) {
  const now = new Date().toISOString()
  return {
    schemaVersion: "1.0", sessionId, goal: "Release lifecycle proof", autonomyLevel: "full", status: "planning", createdAt: now, completedAt: null,
    milestones: [{ id: "m1", name: "Release", description: "Packed runtime lifecycle", status: "pending", order: 1, requiresApproval: false,
      features: [{ id: "f1", name: "Proof", description: "Exercise fail-closed gates", acceptanceCriteria: "Unsafe lifecycle is denied", protocolLevel: "full", status: "pending", order: 1, subAgentSessionId: null, attempts: 0, maxAttempts: 2,
        verification: { passed: false, testResults: null, issues: [], score: null, featureDigest: null },
        evidence: { worker: { childRunId: null, startedAt: null, completedAt: null, receipt: null, summary: null, traceId: null }, auditor: { childRunId: null, startedAt: null, completedAt: null, verdict: null, summary: null, traceId: null }, history: [] },
        skillsRequired: [], skillsGenerated: [] }] }],
    skills: { global: [], sessionScoped: [] }, stats: { totalFeatures: 1, completedFeatures: 0, failedFeatures: 0, totalRetries: 0, estimatedCost: null },
  }
}

async function packagedMcp(plugin, env, project, requests) {
  const input = `${requests.join("\n")}\n`
  const result = await run(process.execPath, [join(plugin, "dist", "mcp.js")], { cwd: project, env, input, timeoutMs: 30_000 })
  return { result, messages: parseJsonLines(result.stdout) }
}

async function hook(plugin, env, project, event, payload) {
  const result = await run(process.execPath, [join(plugin, "dist", "hook.js"), event], { cwd: project, env, input: JSON.stringify(payload), timeoutMs: event === "PostToolBatch" ? 210_000 : 30_000 })
  const parsed = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {}
  return { result, parsed }
}

async function main() {
  const keepOnFailure = process.env.PARALLAX_RELEASE_KEEP_ON_FAILURE === "1"
  const useAuth = process.env.PARALLAX_RELEASE_USE_ENV_AUTH === "1"
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const reportDir = join(root, ".parallax", "release-proof")
  const reportPath = join(reportDir, `${stamp}-report.json`)
  const work = mkdtempSync(join(tmpdir(), "parallax release proof "))
  const packDir = join(work, "real npm pack"); const plugin = join(work, "packed plugin with spaces")
  const project = join(work, "isolated project with spaces"); const config = join(work, "isolated claude config")
  for (const path of [reportDir, packDir, plugin, project, config]) mkdirSync(path, { recursive: true })
  writeFileSync(join(config, "settings.json"), "{}\n")
  const checks = []
  const addRun = async (id, command, args, options = {}) => {
    const result = await run(command, args, { cwd: root, env: process.env, timeoutMs: options.timeoutMs ?? 600_000, ...options })
    checks.push(checkRecord(id, "process", result.code === 0 && !result.timedOut ? "pass" : "fail", `exit=${result.code} timeout=${result.timedOut}\n${result.stdout}\n${result.stderr}`))
    if (result.code !== 0 || result.timedOut) throw new Error(`${id} failed`)
    return result
  }
  let fatal = null
  try {
    rmSync(join(root, "dist"), { recursive: true, force: true })
    await addRun("clean-build", ...npmInvocation(["run", "build"]))
    await addRun("npm-check", ...npmInvocation(["run", "check"]))
    const [npmAudit, npmAuditArgs] = npmInvocation(["audit", "--json", `--audit-level=${AUDIT_LEVEL}`, "--include=prod", "--include=dev", "--include=optional", "--include=peer"])
    const auditResult = await run(npmAudit, npmAuditArgs, { cwd: root, env: process.env, timeoutMs: 180_000 })
    let audit
    try { audit = parseAuditReport(auditResult.stdout, AUDIT_LEVEL) } catch (error) {
      checks.push(checkRecord("npm-audit", "dependency-security", "fail", `${error instanceof Error ? error.message : String(error)}; exit=${auditResult.code}; timeout=${auditResult.timedOut}; stderr=${auditResult.stderr}`, { auditLevel: AUDIT_LEVEL, dependencyScope: "prod,dev,optional,peer" }))
      throw new Error("npm audit output was not trustworthy")
    }
    const auditOkay = auditResult.code === 0 && !auditResult.timedOut && audit.applicable === 0
    checks.push(checkRecord("npm-audit", "dependency-security", auditOkay ? "pass" : "fail", `level=${AUDIT_LEVEL}; scope=prod,dev,optional,peer; applicable=${audit.applicable}; total=${audit.total}; counts=${JSON.stringify(audit.counts)}; exit=${auditResult.code}; timeout=${auditResult.timedOut}`, { auditLevel: AUDIT_LEVEL, dependencyScope: "prod,dev,optional,peer", vulnerabilities: audit }))
    if (!auditOkay) throw new Error(`npm audit found ${audit.applicable} ${AUDIT_LEVEL}-or-higher vulnerabilities or did not exit cleanly`)
    for (const manifest of ["plugin.json", "marketplace.json"]) await addRun(`strict-${manifest}`, "claude", ["plugin", "validate", "--strict", join(root, ".claude-plugin", manifest)], { timeoutMs: 60_000 })
    const version = await addRun("claude-version", "claude", ["--version"], { timeoutMs: 30_000 })
    if (!/^2\.1\.215\b/m.test(version.stdout)) throw new Error(`Expected Claude Code 2.1.215, observed ${version.stdout.trim()}`)

    const [npmPack, npmPackArgs] = npmInvocation(["pack", "--json", "--pack-destination", packDir])
    const packed = await addRun("npm-pack-real", npmPack, npmPackArgs, { timeoutMs: 180_000 })
    const metadata = JSON.parse(packed.stdout)[0]
    const archive = join(packDir, basename(metadata.filename))
    const bytes = readFileSync(archive); const entries = parseTar(bytes); const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const problems = archiveProblems(entries, manifest)
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
    const shasum = createHash("sha1").update(bytes).digest("hex")
    const packedManifestEntry = entries.find((entry) => entry.name === "package/package.json")
    const packedManifest = packedManifestEntry ? JSON.parse(packedManifestEntry.data.toString("utf8")) : null
    if (problems.length || integrity !== metadata.integrity || shasum !== metadata.shasum || packedManifest?.name !== manifest.name || packedManifest?.version !== manifest.version) {
      throw new Error(`Archive inspection failed: ${[...problems, integrity !== metadata.integrity ? "integrity mismatch" : "", shasum !== metadata.shasum ? "shasum mismatch" : "", !packedManifest ? "package.json absent" : ""].filter(Boolean).join("; ")}`)
    }
    checks.push(checkRecord("archive-inspection", "artifact", "pass", `${entries.length} entries; allowlist, modes, sha1, sha512, name and version verified`))
    extract(entries, plugin)
    checks.push(checkRecord("space-path-extraction", "artifact", existsSync(join(plugin, "dist", "hook.js")) ? "pass" : "fail", relative(work, plugin)))
    for (const manifestName of ["plugin.json", "marketplace.json"]) await addRun(`strict-extracted-${manifestName}`, "claude", ["plugin", "validate", "--strict", join(plugin, ".claude-plugin", manifestName)], { timeoutMs: 60_000 })

    writeFileSync(join(project, "package.json"), JSON.stringify({ private: true, scripts: { check: "node check.mjs" } }, null, 2))
    writeFileSync(join(project, "check.mjs"), "import { existsSync } from 'node:fs'; if (!existsSync('proof.txt')) process.exit(1)\n")
    const env = isolatedEnv(work, project, config, useAuth)
    const discovery = await packagedMcp(plugin, env, project, [request(1, "initialize"), request(2, "tools/list"), request(3, "tools/call", { name: "definitely_unknown", arguments: {} })])
    const initialized = discovery.messages.find((message) => message.id === 1)?.result
    const tools = discovery.messages.find((message) => message.id === 2)?.result?.tools ?? []
    const unknown = discovery.messages.find((message) => message.id === 3)?.result
    const expectedTools = ["parallax_checkin", "parallax_verify", "horizon_begin_worker", "horizon_record_audit"]
    const mcpOkay = discovery.result.code === 0 && initialized?.serverInfo?.version === manifest.version && expectedTools.every((name) => tools.some((tool) => tool.name === name))
    checks.push(checkRecord("packed-mcp-discovery", "runtime-direct", mcpOkay ? "pass" : "fail", `server=${initialized?.serverInfo?.name}@${initialized?.serverInfo?.version}; tools=${tools.length}`))
    checks.push(checkRecord("unknown-tool-fail-closed", "runtime-direct", unknown?.isError === true ? "pass" : "fail", unknown?.content?.[0]?.text ?? "missing response"))

    const lifecycleSession = "release-lifecycle"
    const lifecycle = await packagedMcp(plugin, env, project, [
      request(1, "tools/call", { name: "horizon_init_session", arguments: { sessionId: lifecycleSession, goal: "Release lifecycle proof", autonomyLevel: "full" } }),
      request(2, "tools/call", { name: "horizon_write_plan", arguments: { sessionId: lifecycleSession, planJson: JSON.stringify(horizonPlan(lifecycleSession)) } }),
    ])
    if (lifecycle.result.code !== 0 || lifecycle.messages.some((message) => message.result?.isError)) throw new Error(`Could not initialize packed Horizon lifecycle fixture: ${JSON.stringify(lifecycle.messages)}`)
    const parent = randomUUID(); const parentBase = { session_id: parent, cwd: project }
    await hook(plugin, env, project, "SessionStart", parentBase)
    const dispatchPrompt = `HORIZON_DISPATCH {"sessionId":"${lifecycleSession}","featureId":"f1"}\nAtomic release proof`
    const unknownRole = await hook(plugin, env, project, "PreToolUse", { ...parentBase, tool_name: "Agent", tool_use_id: "unknown-role", tool_input: { subagent_type: "horizon-worker", prompt: dispatchPrompt } })
    const background = await hook(plugin, env, project, "PreToolUse", { ...parentBase, tool_name: "Agent", tool_use_id: "background-role", tool_input: { subagent_type: "parallax-claudecode:horizon-worker", prompt: dispatchPrompt, run_in_background: true } })
    const foreground = await hook(plugin, env, project, "PreToolUse", { ...parentBase, tool_name: "Agent", tool_use_id: "foreground-role", tool_input: { subagent_type: "parallax-claudecode:horizon-worker", prompt: dispatchPrompt, description: "foreground release worker" } })
    const overlap = await hook(plugin, env, project, "PreToolUse", { ...parentBase, tool_name: "Agent", tool_use_id: "overlap-role", tool_input: { subagent_type: "parallax-claudecode:horizon-worker", prompt: dispatchPrompt } })
    const roleGateOkay = unknownRole.parsed?.hookSpecificOutput?.permissionDecision === "deny"
      && background.parsed?.hookSpecificOutput?.permissionDecision === "deny"
      && foreground.parsed?.hookSpecificOutput?.permissionDecision !== "deny"
      && overlap.parsed?.hookSpecificOutput?.permissionDecision === "deny"
    checks.push(checkRecord("horizon-lifecycle-gates", "runtime-direct", roleGateOkay ? "pass" : "fail", `unknown=${unknownRole.parsed?.hookSpecificOutput?.permissionDecision}; background=${background.parsed?.hookSpecificOutput?.permissionDecision}; foreground=${foreground.parsed?.hookSpecificOutput?.permissionDecision ?? "reserved"}; overlap=${overlap.parsed?.hookSpecificOutput?.permissionDecision}`))

    const session = randomUUID(); const base = { session_id: session, cwd: project }
    await hook(plugin, env, project, "SessionStart", base)
    const blocked = await hook(plugin, env, project, "PreToolUse", { ...base, tool_name: "Write", tool_use_id: "blocked", tool_input: { file_path: join(project, "proof.txt"), content: "proof\n" } })
    const denied = blocked.parsed?.hookSpecificOutput?.permissionDecision === "deny" && !existsSync(join(project, "proof.txt"))
    checks.push(checkRecord("prewrite-denial", "runtime-direct", denied ? "pass" : "fail", `decision=${blocked.parsed?.hookSpecificOutput?.permissionDecision ?? "missing"}; targetAbsent=${!existsSync(join(project, "proof.txt"))}`))
    const checkins = ["ambiguity", "invariants", "gate"].map((step, index) => request(index + 1, "tools/call", { name: "parallax_checkin", arguments: { sessionId: session, step, evidence: `${step} deterministic release evidence` } }))
    const checked = await packagedMcp(plugin, env, project, checkins)
    if (checked.result.code !== 0 || checked.messages.some((message) => message.result?.isError)) throw new Error("Packed MCP check-ins failed")
    const allowedInput = { file_path: join(project, "proof.txt"), content: "proof\n" }
    const allowed = await hook(plugin, env, project, "PreToolUse", { ...base, tool_name: "Write", tool_use_id: "allowed", tool_input: allowedInput })
    if (allowed.parsed?.hookSpecificOutput?.permissionDecision) throw new Error("Write remained denied after ordered check-ins")
    writeFileSync(join(project, "proof.txt"), "proof\n")
    await hook(plugin, env, project, "PostToolBatch", { ...base, tool_calls: [{ tool_name: "Write", tool_use_id: "allowed", tool_input: allowedInput, tool_response: "File written" }] })
    const ledgerPath = join(project, ".parallax", "verification-ledger.jsonl")
    const receipts = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line))
    const statePath = join(project, ".parallax", "sessions", session, "state.json")
    const beforeResume = JSON.parse(readFileSync(statePath, "utf8"))
    await hook(plugin, env, project, "SessionStart", { ...base, source: "resume" })
    const afterResume = JSON.parse(readFileSync(statePath, "utf8"))
    const receiptOkay = receipts.length === 1 && receipts[0].schemaVersion === 2 && receipts[0].verdict === "pass" && receipts[0].changedFiles?.some((path) => path.endsWith("proof.txt"))
      && beforeResume.trace.verifications?.[0]?.id === afterResume.trace.verifications?.[0]?.id
    checks.push(checkRecord("packaged-gate-receipt-resume", "runtime-direct", receiptOkay ? "pass" : "fail", `receipts=${receipts.length}; id=${receipts[0]?.id ?? "missing"}; verdict=${receipts[0]?.verdict ?? "missing"}; resumed=${beforeResume.trace.verifications?.[0]?.id === afterResume.trace.verifications?.[0]?.id}`))

    const roleFiles = ["horizon-worker.md", "horizon-auditor.md"].map((name) => readFileSync(join(plugin, "agents", name), "utf8"))
    const roleProblems = roleBoundaryProblems(roleFiles[0], roleFiles[1])
    checks.push(checkRecord("packaged-role-boundaries", "static-native-config", roleProblems.length ? "fail" : "pass", roleProblems.length ? roleProblems.join("; ") : "Packed native role frontmatter has every required allowed capability and explicit complete forbidden sets; this proves packaged configuration, not Claude's per-agent effective runtime tools"))
    if (roleProblems.length) throw new Error("Packed native role boundaries were incomplete")

    const initPrompt = "Reply only with READY. Do not call tools."
    const bare = await run("claude", ["-p", initPrompt, "--bare", "--plugin-dir", plugin, "--settings", join(config, "settings.json"), "--output-format", "stream-json", "--verbose", "--max-budget-usd", "0.01"], { cwd: project, env, timeoutMs: 120_000 })
    const bareInit = parseJsonLines(bare.stdout).find((event) => event.type === "system" && event.subtype === "init")
    const barePlugin = JSON.stringify(bareInit?.plugins ?? []).includes("parallax-claudecode")
    checks.push(checkRecord("claude-bare-artifact-load", "runtime-cli", barePlugin ? "pass" : "fail", `pluginListed=${barePlugin}; mcpServers=${bareInit?.mcp_servers?.length ?? 0}; Claude Code 2.1.215 bare mode intentionally omits plugin hooks/MCP/agents, so isolated non-bare discovery follows`, { modelDependent: false }))
    const claudeArgs = ["-p", initPrompt, "--plugin-dir", plugin, "--settings", join(config, "settings.json"), "--output-format", "stream-json", "--include-hook-events", "--verbose", "--max-budget-usd", "0.01"]
    const claude = await run("claude", claudeArgs, { cwd: project, env, timeoutMs: 120_000 })
    const events = parseJsonLines(claude.stdout); const init = events.find((event) => event.type === "system" && event.subtype === "init")
    const authUnavailable = /auth|api key|login|credential/i.test(`${claude.stderr}\n${claude.stdout}`) && !init
    if (!init) {
      const verdict = authUnavailable ? "skipped" : "fail"
      const detail = authUnavailable ? "Bare isolated mode has no model authentication; no system/init event was emitted" : `No system/init event; exit=${claude.code}; ${claude.stderr}`
      checks.push(checkRecord("claude-plugin-init", "runtime-cli-advisory", verdict, detail, { applicable: verdict !== "skipped", advisory: verdict === "skipped", modelDependent: true }))
      checks.push(checkRecord("claude-gate-smoke", "runtime-cli-advisory", "skipped", "Authenticated model turn unavailable; non-applicable advisory because direct packed hook/MCP tests prove the deterministic gate criteria", { applicable: false, advisory: true, modelDependent: true }))
      checks.push(checkRecord("claude-role-smoke", "runtime-cli-advisory", "skipped", "Authenticated scoped-agent turns unavailable; non-applicable advisory. Packaged native frontmatter is checked separately; no effective runtime tool-set claim is made", { applicable: false, advisory: true, modelDependent: true }))
    } else {
      const pluginText = JSON.stringify(init)
      const initOkay = pluginText.includes("parallax-claudecode") && (!Array.isArray(init.plugin_errors) || init.plugin_errors.length === 0)
        && expectedTools.every((name) => pluginText.includes(name)) && initialized?.serverInfo?.version === manifest.version
      const initSummary = { plugins: init.plugins, mcp_servers: init.mcp_servers, parallaxTools: (init.tools ?? []).filter((name) => String(name).includes("parallax")), parallaxAgents: (init.agents ?? []).filter((name) => String(name).includes("horizon") || String(name).includes("parallax")), pluginErrors: init.plugin_errors }
      checks.push(checkRecord("claude-plugin-init", "runtime-cli", initOkay ? "pass" : "fail", `session=${init.session_id ?? "unknown"}; plugin/tool assertions=${initOkay}; packedMcpVersion=${initialized?.serverInfo?.version}; discovery=${JSON.stringify(initSummary)}`, { modelDependent: false }))
      const cliProject = join(work, "authenticated cli project with spaces"); mkdirSync(cliProject, { recursive: true })
      writeFileSync(join(cliProject, "package.json"), JSON.stringify({ private: true, scripts: { check: "node check.mjs" } }, null, 2))
      writeFileSync(join(cliProject, "check.mjs"), "import { existsSync } from 'node:fs'; if (!existsSync('cli-proof.txt')) process.exit(1)\n")
      const cliEnv = isolatedEnv(work, cliProject, config, useAuth)
      const gatePrompt = "Follow exactly: (1) call Write for blocked.txt before any MCP call; (2) after it is denied, call parallax_checkin for ambiguity, invariants, and gate in order with concrete evidence; (3) call Write for cli-proof.txt containing proof; (4) reply DONE. Do not use Bash, Edit, or other tools."
      const gateArgs = ["-p", gatePrompt, "--plugin-dir", plugin, "--settings", join(config, "settings.json"), "--permission-mode", "acceptEdits", "--allowedTools", "Write,mcp__plugin_parallax-claudecode_parallax__parallax_checkin", "--output-format", "stream-json", "--include-hook-events", "--verbose", "--max-budget-usd", "0.10"]
      const gate = await run("claude", gateArgs, { cwd: cliProject, env: cliEnv, timeoutMs: 240_000 })
      const gateEvents = parseJsonLines(gate.stdout); const gateInit = gateEvents.find((event) => event.type === "system" && event.subtype === "init")
      const gateText = JSON.stringify(gateEvents); const gateSession = gateInit?.session_id
      const cliLedger = join(cliProject, ".parallax", "verification-ledger.jsonl")
      const cliReceipts = existsSync(cliLedger) ? readFileSync(cliLedger, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : []
      const gateAuthUnavailable = /auth|api key|login|credential/i.test(`${gate.stderr}\n${gate.stdout}`) && !existsSync(join(cliProject, "cli-proof.txt"))
      const gateOkay = gate.code === 0 && /permissionDecision[^}]*deny|permission_decision[^}]*deny/i.test(gateText)
        && !existsSync(join(cliProject, "blocked.txt")) && existsSync(join(cliProject, "cli-proof.txt"))
        && cliReceipts.length === 1 && cliReceipts[0].schemaVersion === 2 && cliReceipts[0].verdict === "pass"
      let resumed = false
      if (gateSession) {
        const resume = await run("claude", ["-p", "Call parallax_trace_view, then reply RESUMED.", "--resume", gateSession, "--plugin-dir", plugin, "--settings", join(config, "settings.json"), "--allowedTools", "mcp__plugin_parallax-claudecode_parallax__parallax_trace_view", "--output-format", "stream-json", "--verbose", "--max-budget-usd", "0.05"], { cwd: cliProject, env: cliEnv, timeoutMs: 180_000 })
        const after = existsSync(cliLedger) ? readFileSync(cliLedger, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : []
        resumed = resume.code === 0 && after.length === 1 && after[0].id === cliReceipts[0]?.id
      }
      checks.push(checkRecord("claude-gate-smoke", "runtime-cli-advisory", gateAuthUnavailable ? "skipped" : gateOkay && resumed ? "pass" : "fail", gateAuthUnavailable ? "Isolated CLI plugin initialization succeeded, but model authentication was unavailable; non-applicable advisory and no mutation claim was inferred" : `exit=${gate.code}; denied=${/permissionDecision[^}]*deny|permission_decision[^}]*deny/i.test(gateText)}; targetAbsent=${!existsSync(join(cliProject, "blocked.txt"))}; receipt=${cliReceipts[0]?.id ?? "missing"}; resumed=${resumed}`, { applicable: !gateAuthUnavailable, advisory: gateAuthUnavailable, modelDependent: true }))

      const roleToolSets = {}
      for (const role of ["horizon-worker", "horizon-auditor"]) {
        const scoped = `parallax-claudecode:${role}`
        const roleRun = await run("claude", ["-p", "Reply ROLE_READY without tools.", "--agent", scoped, "--plugin-dir", plugin, "--settings", join(config, "settings.json"), "--output-format", "stream-json", "--verbose", "--max-budget-usd", "0.02"], { cwd: cliProject, env: cliEnv, timeoutMs: 120_000 })
        const roleInit = parseJsonLines(roleRun.stdout).find((event) => event.type === "system" && event.subtype === "init")
        roleToolSets[role] = { exit: roleRun.code, tools: roleInit?.tools ?? [], agents: roleInit?.agents ?? [], error: roleRun.stderr }
      }
      const rolesObserved = (roleToolSets["horizon-worker"]?.tools?.length ?? 0) > 0 && (roleToolSets["horizon-auditor"]?.tools?.length ?? 0) > 0
      const roleAuthUnavailable = !rolesObserved && /auth|api key|login|credential/i.test(`${roleToolSets["horizon-worker"]?.error}\n${roleToolSets["horizon-auditor"]?.error}`)
      checks.push(checkRecord("claude-role-smoke", "runtime-cli-inventory-advisory", roleAuthUnavailable ? "skipped" : rolesObserved ? "pass" : "fail", roleAuthUnavailable ? "Scoped role turns require unavailable isolated model authentication; non-applicable advisory" : `Scoped role init inventories observed: workerTools=${roleToolSets["horizon-worker"]?.tools?.length ?? 0}; auditorTools=${roleToolSets["horizon-auditor"]?.tools?.length ?? 0}. Claude init does not establish per-agent effective permissions, so no runtime restriction claim is inferred`, { applicable: !roleAuthUnavailable, advisory: roleAuthUnavailable, modelDependent: true, effectiveToolSetExposed: false }))
    }
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error)
    if (!checks.some((check) => check.verdict === "fail")) checks.push(checkRecord("release-proof-internal", "process", "fail", fatal))
  }
  const outcome = computeReportVerdict(checks)
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    artifact: { package: "parallax-claudecode", claudeCode: "2.1.215" },
    policy: { applicableChecksRequirePass: true, advisoryAuthenticationSkipsAreNonApplicable: true, npmAuditLevel: AUDIT_LEVEL, npmAuditDependencyScope: ["prod", "dev", "optional", "peer"], useEnvironmentAuthentication: useAuth, keepOnFailure },
    verdict: outcome.verdict,
    publishable: outcome.publishable,
    checks,
    fatal: fatal ? redact(fatal) : null,
  }
  mkdirSync(reportDir, { recursive: true }); writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const keep = keepOnFailure && !outcome.publishable
  if (!keep) rmSync(work, { recursive: true, force: true })
  console.log(`[release-proof] report=${reportPath}`)
  console.log(`[release-proof] verdict=${report.verdict} publishable=${report.publishable}${keep ? ` fixture=${work}` : ""}`)
  process.exitCode = outcome.publishable ? 0 : 1
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main()
