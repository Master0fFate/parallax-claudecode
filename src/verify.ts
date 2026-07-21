import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { getVerifyCommands } from "./detect.js"
import { createVerificationRecord } from "./trace.js"
import type { ProjectDetection, VerificationRecord, VerificationSource, VerifyCommand } from "./types.js"

export const DEFAULT_OUTPUT_MAX_BYTES = 50_000
export const DEFAULT_OUTPUT_MAX_LINES = 1_000
const WINDOWS_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "bun"])

export interface VerificationOptions {
  timeoutMs?: number
  thorough?: boolean
  commands?: VerifyCommand[]
  signal?: AbortSignal
  sessionId?: string
  source?: VerificationSource
  outputMaxBytes?: number
  outputMaxLines?: number
  /** @internal Deterministic clock seam for verification orchestration tests. */
  now?: () => number
  /** @internal Binds automatic evidence to its durable mutation claim. */
  receiptId?: string
}

interface ExecutionResult {
  exitCode: number | null
  stdout: string
  stderr: string
  combined: string
  outputTruncated: boolean
  timedOut: boolean
  reason: string | null
}

function boundOutput(value: string, maxBytes: number, maxLines: number): { value: string; truncated: boolean } {
  let result = value
  let truncated = false
  const lines = result.split("\n")
  if (lines.length > maxLines) {
    result = lines.slice(-maxLines).join("\n")
    truncated = true
  }
  const bytes = Buffer.from(result)
  if (bytes.byteLength > maxBytes) {
    result = bytes.subarray(bytes.byteLength - maxBytes).toString("utf8")
    while (Buffer.byteLength(result) > maxBytes) result = result.slice(1)
    truncated = true
  }
  return { value: result, truncated }
}

function normalizeChangedFiles(files: readonly string[]): string[] {
  const unique = new Set(files.map((file) => file.trim().replaceAll("\\", "/").replace(/^\.\//, "")).filter(Boolean))
  return [...unique].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
}

function execute(command: VerifyCommand, cwd: string, timeoutMs: number, maxBytes: number, maxLines: number, signal?: AbortSignal): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const usesWindowsShim = process.platform === "win32" && WINDOWS_SHIMS.has(command.command)
    const executable = usesWindowsShim ? (process.env.ComSpec || "cmd.exe") : command.command
    const args = usesWindowsShim ? ["/d", "/s", "/c", `${command.command}.cmd`, ...command.args] : command.args
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executable, args, { cwd, windowsHide: true, shell: false, detached: process.platform !== "win32" })
    } catch (error) {
      const reason = `Verification process could not be spawned: ${String(error)}`
      const bounded = boundOutput(reason, maxBytes, maxLines)
      resolve({
        exitCode: null,
        stdout: "",
        stderr: bounded.value,
        combined: bounded.value,
        outputTruncated: bounded.truncated,
        timedOut: false,
        reason,
      })
      return
    }
    let stdout = ""
    let stderr = ""
    let combined = ""
    let outputTruncated = false
    let settled = false
    let forcedExit: NodeJS.Timeout | undefined
    let timedOut = false
    let reason: string | null = null
    const append = (current: string, value: string): string => {
      const bounded = boundOutput(`${current}${value}`, maxBytes, maxLines)
      outputTruncated ||= bounded.truncated
      return bounded.value
    }
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forcedExit) clearTimeout(forcedExit)
      signal?.removeEventListener("abort", abort)
      if (exitCode === null && !reason) reason = "Verification process exited without an exit code."
      resolve({ exitCode, stdout, stderr, combined, outputTruncated, timedOut, reason })
    }
    const killTree = (force: boolean): void => {
      if (!child.pid) return
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])], { windowsHide: true, stdio: "ignore" })
        killer.unref()
      } else {
        try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM") } catch { /* process already exited */ }
      }
    }
    const terminate = (message: string, timeout: boolean): void => {
      if (settled || forcedExit) return
      reason = message
      timedOut = timeout
      stderr = append(stderr, `${stderr ? "\n" : ""}${message}`)
      combined = append(combined, `${combined ? "\n" : ""}${message}`)
      killTree(false)
      forcedExit = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" })
          const hardFinish = setTimeout(() => finish(null), 2_000)
          hardFinish.unref()
          killer.once("close", () => { clearTimeout(hardFinish); setTimeout(() => finish(null), 25) })
          killer.once("error", () => { clearTimeout(hardFinish); finish(null) })
        } else {
          killTree(true)
          finish(null)
        }
      }, 1_000)
      forcedExit.unref()
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString()
      stdout = append(stdout, text)
      combined = append(combined, text)
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString()
      stderr = append(stderr, text)
      combined = append(combined, text)
    })
    child.on("error", (error) => {
      reason = `Verification process could not be spawned: ${String(error)}`
      stderr = append(stderr, `${stderr ? "\n" : ""}${reason}`)
      combined = append(combined, `${combined ? "\n" : ""}${reason}`)
      finish(null)
    })
    child.on("close", (code) => finish(forcedExit || reason ? null : code))
    const abort = (): void => terminate("Verification cancelled.", false)
    const timer = setTimeout(() => terminate(`Verification timed out after ${timeoutMs}ms.`, true), timeoutMs)
    timer.unref()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export async function runVerification(
  project: ProjectDetection,
  files: readonly string[],
  options: VerificationOptions = {},
): Promise<VerificationRecord> {
  const now = options.now ?? Date.now
  const started = now()
  const startedAt = new Date(started).toISOString()
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxBytes = options.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES
  const maxLines = options.outputMaxLines ?? DEFAULT_OUTPUT_MAX_LINES
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || !Number.isInteger(maxBytes) || maxBytes < 1 || !Number.isInteger(maxLines) || maxLines < 1) {
    throw new Error("Verification timeout and output bounds must be non-negative/positive integers")
  }
  const detected = options.commands ?? getVerifyCommands(project)
  const commands = options.thorough ? detected : detected.slice(0, 1)
  const changedFiles = normalizeChangedFiles(files)
  const identity: { startedAt: string; id?: string } = options.receiptId ? { startedAt, id: options.receiptId } : { startedAt }
  const common = { sessionId: options.sessionId ?? "unknown-session", source: options.source ?? "manual", cwd: project.root, timeoutMs, changedFiles }
  if (commands.length === 0) {
    const skipReason = "No supported verification command detected."
    return createVerificationRecord({ ...common, command: null, args: [], verdict: "skipped", exitCode: null, durationMs: now() - started, stdout: "", stderr: skipReason, combined: skipReason, outputTruncated: false, timedOut: false, skipReason }, identity)
  }

  let stdout = ""
  let stderr = ""
  let combined = ""
  let outputTruncated = false
  let exitCode: number | null = 0
  let timedOut = false
  let reason: string | null = null
  const executed: VerifyCommand[] = []
  const merge = (current: string, value: string): string => {
    const bounded = boundOutput([current, value].filter(Boolean).join("\n\n"), maxBytes, maxLines)
    outputTruncated ||= bounded.truncated
    return bounded.value
  }
  for (const command of commands) {
    const remaining = timeoutMs - (now() - started)
    if (remaining <= 0) {
      exitCode = null
      timedOut = true
      reason = "Verification timeout exhausted."
      stderr = merge(stderr, reason)
      combined = merge(combined, reason)
      break
    }
    executed.push(command)
    const result = await execute(command, project.root, remaining, maxBytes, maxLines, options.signal)
    stdout = merge(stdout, result.stdout)
    stderr = merge(stderr, result.stderr)
    combined = merge(combined, result.combined)
    outputTruncated ||= result.outputTruncated
    exitCode = result.exitCode
    timedOut = result.timedOut
    reason = result.reason
    if (exitCode !== 0 || reason) break
  }
  const command = executed.map((item) => item.label).join(" && ")
  const args = executed.flatMap((item) => [item.command, ...item.args])
  const verdict = reason || exitCode === null ? "unknown" : exitCode === 0 ? "pass" : "fail"
  return createVerificationRecord({
    ...common, command, args, verdict, exitCode: verdict === "unknown" ? null : exitCode,
    durationMs: now() - started, stdout, stderr, combined, outputTruncated, timedOut,
    skipReason: verdict === "unknown" ? reason ?? "Verification outcome was indeterminate." : null,
  }, identity)
}
