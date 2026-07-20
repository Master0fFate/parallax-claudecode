import { spawn } from "node:child_process"
import { getVerifyCommands } from "./detect.js"
import { createVerificationRecord } from "./trace.js"
import type { ProjectDetection, VerificationRecord, VerifyCommand } from "./types.js"

const MAX_CAPTURE_CHARS = 50_000
const WINDOWS_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "bun"])

export interface VerificationOptions {
  timeoutMs?: number
  thorough?: boolean
  commands?: VerifyCommand[]
  signal?: AbortSignal
}

function execute(command: VerifyCommand, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{
  exitCode: number
  stdout: string
  stderr: string
}> {
  return new Promise((resolve) => {
    const usesWindowsShim = process.platform === "win32" && WINDOWS_SHIMS.has(command.command)
    const executable = usesWindowsShim ? (process.env.ComSpec || "cmd.exe") : command.command
    const args = usesWindowsShim ? ["/d", "/s", "/c", `${command.command}.cmd`, ...command.args] : command.args
    const child = spawn(executable, args, { cwd, windowsHide: true, shell: false, detached: process.platform !== "win32" })
    let stdout = ""
    let stderr = ""
    let settled = false
    let forcedExit: NodeJS.Timeout | undefined
    const append = (current: string, value: string): string => `${current}${value}`.slice(-MAX_CAPTURE_CHARS)
    const finish = (exitCode: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (forcedExit) clearTimeout(forcedExit)
      signal?.removeEventListener("abort", abort)
      resolve({ exitCode, stdout, stderr })
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
    const terminate = (reason: string): void => {
      if (settled || forcedExit) return
      stderr = append(stderr, `${stderr ? "\n" : ""}${reason}`)
      killTree(false)
      forcedExit = setTimeout(() => {
        if (process.platform === "win32" && child.pid) {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" })
          const hardFinish = setTimeout(() => finish(-1), 1_000)
          hardFinish.unref()
          killer.once("close", () => { clearTimeout(hardFinish); setTimeout(() => finish(-1), 25) })
          killer.once("error", () => { clearTimeout(hardFinish); finish(-1) })
        } else {
          killTree(true)
          finish(-1)
        }
      }, 1_000)
      forcedExit.unref()
    }
    child.stdout.on("data", (chunk: Buffer | string) => { stdout = append(stdout, chunk.toString()) })
    child.stderr.on("data", (chunk: Buffer | string) => { stderr = append(stderr, chunk.toString()) })
    child.on("error", (error) => { stderr = append(stderr, `${stderr ? "\n" : ""}${String(error)}`); finish(-1) })
    child.on("close", (code) => finish(forcedExit ? -1 : code ?? -1))
    const abort = (): void => terminate("Verification cancelled.")
    const timer = setTimeout(() => terminate(`Verification timed out after ${timeoutMs}ms.`), timeoutMs)
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
  const started = Date.now()
  const detected = options.commands ?? getVerifyCommands(project)
  const commands = options.thorough ? detected : detected.slice(0, 1)
  const uniqueFiles = [...new Set(files.filter(Boolean))]
  if (commands.length === 0) {
    return createVerificationRecord({
      command: null,
      files: uniqueFiles,
      verdict: "skipped",
      exitCode: null,
      durationMs: Date.now() - started,
      stdout: "",
      stderr: "No supported verification command detected.",
    })
  }

  const stdout: string[] = []
  const stderr: string[] = []
  const labels: string[] = []
  let exitCode = 0
  const timeoutMs = options.timeoutMs ?? 120_000
  for (const command of commands) {
    const remaining = timeoutMs - (Date.now() - started)
    if (remaining <= 0) {
      exitCode = -1
      stderr.push("Verification timeout exhausted.")
      break
    }
    labels.push(command.label)
    const result = await execute(command, project.root, remaining, options.signal)
    stdout.push(result.stdout)
    stderr.push(result.stderr)
    exitCode = result.exitCode
    if (exitCode !== 0) break
  }
  return createVerificationRecord({
    command: labels.join(" && "),
    files: uniqueFiles,
    verdict: exitCode === 0 ? "pass" : "fail",
    exitCode,
    durationMs: Date.now() - started,
    stdout: stdout.join("\n\n").slice(-MAX_CAPTURE_CHARS),
    stderr: stderr.join("\n\n").slice(-MAX_CAPTURE_CHARS),
  })
}
