#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { applyParallaxConfig, loadParallaxConfig } from "./config.js"
import { detectProject } from "./detect.js"
import { beginProtocolEpoch } from "./protocol.js"
import { createSessionState, SessionStore } from "./state.js"
import { addWriteBatch, checkpointTrace, exportTrace, finalizeTrace } from "./trace.js"
import { runVerification } from "./verify.js"
import type { ClaudeHookInput, ParallaxConfig, ProtocolStep, SessionState } from "./types.js"

/** Native Claude lifecycle events handled by the dispatcher. */
export type ParallaxHookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolBatch"
  | "PostToolUseFailure"
  | "SubagentStart"
  | "PreCompact"
  | "Stop"
  | "SessionEnd"

const EVENTS = new Set<ParallaxHookEvent>([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "SubagentStart",
  "PreCompact",
  "Stop",
  "SessionEnd",
])
// Bash is mutation-capable even when a particular command appears read-only. Treating it
// otherwise leaves an unrestricted shell write bypass around the native file-tool gate.
const MUTATION_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "Bash"])
const STRICT_WRITE_PREREQUISITES: ProtocolStep[] = ["ambiguity", "invariants", "gate"]
const SOFT_INVARIANT_WRITE_LIMIT = 3

async function readStdin(): Promise<ClaudeHookInput> {
  let body = ""
  for await (const chunk of process.stdin) body += chunk.toString()
  if (!body.trim()) return {}
  const value: unknown = JSON.parse(body)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude hook input must be a JSON object")
  return value as ClaudeHookInput
}

function sessionId(input: ClaudeHookInput): string {
  if (typeof input.session_id !== "string" || !input.session_id.trim()) throw new Error("Claude hook input did not include session_id")
  return input.session_id
}

/** Recursively finds all native and compatibility file path fields in a tool batch. */
export function collectWrittenPaths(value: unknown): string[] {
  const files: string[] = []
  const visited = new Set<object>()
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object" || visited.has(item)) return
    visited.add(item)
    if (Array.isArray(item)) {
      for (const child of item) visit(child)
      return
    }
    const record = item as Record<string, unknown>
    for (const key of ["file_path", "filePath", "notebook_path", "notebookPath"] as const) {
      if (typeof record[key] === "string" && record[key].trim()) files.push(record[key].trim())
    }
    for (const child of Object.values(record)) visit(child)
  }
  visit(value)
  return [...new Set(files)]
}

function hookContext(event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolBatch" | "PostToolUseFailure" | "SubagentStart", message: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: message } }
}

function systemMessage(message: string): Record<string, unknown> {
  return { systemMessage: message }
}

function deny(message: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: message,
    },
  }
}

function writePrerequisites(state: SessionState, config: ParallaxConfig): ProtocolStep[] {
  const required = config.strictness === "strict" ? [...STRICT_WRITE_PREREQUISITES] : ["ambiguity" as ProtocolStep]
  // OpenCode standard/relaxed policy permits three mutation batches while invariant
  // evidence is outstanding, then hard-blocks. A multi-file batch consumes one slot.
  const batchesThisEpoch = new Set(state.trace.writes.slice(state.protocol.startedWriteCount).map((write) => write.batchId)).size
  if (config.strictness !== "strict" && !state.protocol.completed.invariants && batchesThisEpoch >= SOFT_INVARIANT_WRITE_LIMIT) required.push("invariants")
  // Claude intentionally enforces required design evidence in every strictness mode and
  // retains ordered gate -> design check-ins; unlike the legacy bypass, omitting invariants
  // cannot silently disable an explicitly required design document.
  if (config.designDocRequired) required.push("invariants", "gate", "design")
  return [...new Set(required)].filter((step) => !state.protocol.completed[step])
}

function protocolStatus(state: SessionState, config: ParallaxConfig): { summary: string; missing: ProtocolStep[] } {
  const completed = Object.values(state.protocol.completed).filter(Boolean).length
  const missing = writePrerequisites(state, config)
  const recovery = state.friction.lastObservation
    ? ` Last failure: ${state.friction.lastObservation.replace(/\s+/g, " ").slice(-400)}`
    : ""
  return {
    summary: `Protocol epoch ${state.protocol.epoch} ${completed}/6; ${config.strictness} write gate ${missing.length ? `blocked (${missing.join(" -> ")})` : "ready"}; retries ${state.friction.retriesLeft}/${state.friction.maxRetries}.${recovery}`,
    missing,
  }
}

function configuredState(store: SessionStore, id: string, _projectRoot: string, config: ParallaxConfig): SessionState {
  return store.update(id, (current) => applyParallaxConfig(current ?? createSessionState(id, store.projectRoot, config.maxRetries), config))
}

function mutationCompleted(call: Record<string, unknown>, results: Map<string, Record<string, unknown>>, hasStructuredResults: boolean): boolean {
  const id = typeof call.tool_use_id === "string" ? call.tool_use_id : typeof call.id === "string" ? call.id : undefined
  const result = id ? results.get(id) : undefined
  // When Claude supplies a structured result list, an ID must correlate the call to a
  // successful result. Never infer success from human-readable response text.
  if (hasStructuredResults && (!id || !result)) return false
  const records = [call, result, call.tool_response].filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)))
  if (records.some((record) => record.is_error === true || record.isError === true || record.denied === true || record.success === false
    || record.cancelled === true || record.canceled === true || record.permission_denied === true
    || (typeof record.error === "string" && record.error.trim().length > 0)
    || (typeof record.stderr === "string" && record.stderr.trim().length > 0)
    || (typeof record.message === "string" && /\b(?:denied|failed|error|blocked|cancelled|canceled|rejected)\b/i.test(record.message)))) return false
  const statuses = records.flatMap((record) => [record.status, record.permission_status, record.outcome]).filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase())
  if (statuses.some((status) => ["denied", "error", "failed", "failure", "cancelled", "canceled", "blocked", "rejected"].includes(status))) return false
  const explicitlySuccessful = statuses.some((status) => ["success", "succeeded", "completed", "ok", "passed"].includes(status)) || result?.success === true || result?.is_error === false
  if (hasStructuredResults && !explicitlySuccessful) return false
  // Compatibility only for older payloads without structured statuses. Ambiguous textual
  // failures fail closed rather than consuming verification or a repair permit.
  if (typeof call.tool_response === "string" && /\b(?:denied|failed|error|blocked|cancelled|canceled|rejected)\b/i.test(call.tool_response)) return false
  return true
}

function toolFailure(input: ClaudeHookInput): string {
  for (const value of [input.error, input.tool_response]) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      for (const key of ["error", "message", "stderr"] as const) {
        if (typeof record[key] === "string" && record[key].trim()) return record[key].trim()
      }
    }
  }
  return "Tool failed without an error message."
}

function updateFriction(state: SessionState, verdict: "pass" | "fail" | "skipped", observation: string | null): void {
  state.friction.lastObservation = verdict === "fail" ? observation : null
  if (verdict === "skipped") return
  state.friction.trials += 1
  if (verdict === "pass") {
    state.friction.successes += 1
    state.friction.consecutiveFailures = 0
    state.friction.retriesLeft = state.friction.maxRetries
    state.friction.recoveryAttempts = 0
    state.friction.repairWritesRemaining = 0
  } else {
    state.friction.consecutiveFailures += 1
    state.friction.retriesLeft = Math.max(0, state.friction.maxRetries - state.friction.consecutiveFailures)
  }
}

function persistTrace(store: SessionStore, id: string, projectRoot: string, final: boolean): { state: SessionState; path: string } | null {
  return store.finalize(id, (state) => {
    if (final) finalizeTrace(state.trace, state.friction.maxRetries)
    else checkpointTrace(state.trace, state.friction.maxRetries)
    const path = exportTrace(state.trace, projectRoot)
    return { state, path }
  })
}

/**
 * Deterministic, process-independent hook dispatcher. Every invocation reads and atomically
 * updates only the state selected by Claude's session_id.
 */
export async function dispatchHook(event: ParallaxHookEvent, input: ClaudeHookInput): Promise<Record<string, unknown>> {
  if (!EVENTS.has(event)) throw new Error(`Unknown hook event: ${String(event)}`)
  const id = sessionId(input)
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd()
  const project = detectProject(cwd)
  const store = new SessionStore(project.root)

  if (event === "SessionStart") {
    const config = loadParallaxConfig(project.root)
    const state = store.update(id, (current) => {
      const next = applyParallaxConfig(current ?? createSessionState(id, store.projectRoot, config.maxRetries), config)
      next.trace.session.projectType = project.type
      return next
    })
    return hookContext("SessionStart", `[parallax] Session ${id} ready (${project.type ?? "unknown"}). ${protocolStatus(state, config).summary}`)
  }

  if (event === "UserPromptSubmit") {
    const config = loadParallaxConfig(project.root)
    const state = store.update(id, (current) => {
      const next = applyParallaxConfig(current ?? createSessionState(id, store.projectRoot, config.maxRetries), config)
      beginProtocolEpoch(next)
      // A user prompt is an explicit manual recovery epoch. It grants a fresh bounded set of
      // verification-only recovery attempts, but does not restore write retries or erase failure.
      next.friction.recoveryAttempts = 0
      next.friction.repairWritesRemaining = 0
      return next
    })
    return hookContext("UserPromptSubmit", `[parallax] Session ${id}. ${protocolStatus(state, config).summary}`)
  }

  if (event === "PreToolUse") {
    const tool = typeof input.tool_name === "string" ? input.tool_name : ""
    if (!MUTATION_TOOLS.has(tool)) return hookContext("PreToolUse", "[parallax] Non-mutation tool; protocol gate not applicable.")
    const config = loadParallaxConfig(project.root)
    const state = configuredState(store, id, project.root, config)
    const status = protocolStatus(state, config)
    if (status.missing.length) {
      return deny(`[parallax] Write blocked. Complete ${status.missing.join(" -> ")} with parallax_checkin for session ${id} and concrete evidence before ${tool}.`)
    }
    if (state.friction.retriesLeft === 0) {
      if (state.friction.repairWritesRemaining === 0) {
        return deny(`[parallax] Write blocked after repeated verification failures. Run parallax_verify; a failing manual recovery check grants one bounded repair batch. ${state.friction.lastObservation ?? ""}`.trim())
      }
      // Consume the permit only after PostToolBatch proves at least one mutation succeeded.
      // Permission denial, cancellation, and tool failure therefore cannot strand recovery.
      return hookContext("PreToolUse", `[parallax] One-shot repair batch authorized after exhausted verification. Run parallax_verify immediately after the repair.`)
    }
    // No permissionDecision means Claude Code's normal permission flow remains authoritative.
    return hookContext("PreToolUse", `[parallax] Write gate passed. ${status.summary}`)
  }

  if (event === "PostToolBatch") {
    // Native PostToolBatch has no matcher and contains every parallel call. Select
    // mutations here so read-only batches do not create verification or write records.
    const structuredResults = Array.isArray(input.tool_results) ? input.tool_results : []
    const results = new Map(structuredResults.flatMap((result) => {
      const resultId = typeof result.tool_use_id === "string" ? result.tool_use_id : typeof result.toolUseId === "string" ? result.toolUseId : typeof result.id === "string" ? result.id : undefined
      return resultId ? [[resultId, result as Record<string, unknown>] as const] : []
    }))
    const calls = Array.isArray(input.tool_calls)
      ? input.tool_calls.filter((call) => call
        && MUTATION_TOOLS.has(typeof call.tool_name === "string" ? call.tool_name : "")
        && mutationCompleted(call, results, structuredResults.length > 0))
      : MUTATION_TOOLS.has(typeof input.tool_name === "string" ? input.tool_name : "")
        ? (() => {
            const call = { ...input, tool_name: input.tool_name, tool_input: input.tool_input }
            return mutationCompleted(call, results, structuredResults.length > 0) ? [call] : []
          })()
        : []
    if (!calls.length) return {}

    const actualFiles: string[] = []
    const recordedFiles: string[] = []
    const tools: string[] = []
    for (const call of calls) {
      const tool = typeof call.tool_name === "string" ? call.tool_name : "unknown"
      if (!tools.includes(tool)) tools.push(tool)
      const paths = collectWrittenPaths(call.tool_input)
      actualFiles.push(...paths)
      recordedFiles.push(...(paths.length ? paths : [`<unknown:${tool}>`]))
    }
    const uniqueActualFiles = [...new Set(actualFiles)]
    const uniqueRecordedFiles = [...new Set(recordedFiles)]
    const config = loadParallaxConfig(project.root)
    const verification = await runVerification(project, uniqueActualFiles)
    const state = store.update(id, (current) => {
      const next = applyParallaxConfig(current ?? (() => { throw new Error(`Parallax session not initialized: ${id}`) })(), config)
      next.trace.session.projectType = project.type
      if (next.friction.retriesLeft === 0 && next.friction.repairWritesRemaining > 0) next.friction.repairWritesRemaining = 0
      updateFriction(next, verification.verdict, (verification.stderr || verification.stdout).slice(-2_000))
      addWriteBatch(next.trace, uniqueRecordedFiles, tools.join("|") || "unknown", verification, next.friction.retriesLeft)
      return next
    })
    const detail = verification.verdict === "pass"
      ? `passed (${verification.command})`
      : verification.verdict === "skipped"
        ? "skipped (no supported command)"
        : `failed; ${state.friction.retriesLeft} retries remain`
    const recovery = verification.verdict === "fail"
      ? ` Recover: ${(verification.stderr || verification.stdout || "verification command failed").replace(/\s+/g, " ").slice(-400)}`
      : ""
    return hookContext("PostToolBatch", `[parallax] Batch verification ${detail}; recorded ${uniqueRecordedFiles.length} path(s).${recovery}`)
  }

  if (event === "PostToolUseFailure") {
    const failure = toolFailure(input).replace(/\s+/g, " ").slice(-1_000)
    const files = collectWrittenPaths(input.tool_input)
    const tool = typeof input.tool_name === "string" ? input.tool_name : "unknown"
    const state = store.update(id, (current) => {
      const next = current ?? (() => { throw new Error(`Parallax session not initialized: ${id}`) })()
      next.friction.lastObservation = failure
      return next
    })
    // PostToolBatch owns write/verification records. Recording here would duplicate
    // failed calls when Claude emits the subsequent native batch event.
    return hookContext("PostToolUseFailure", `[parallax] ${tool} failed${files.length ? ` for ${files.join(", ")}` : ""}. Recover: ${failure.slice(-400)} Retries ${state.friction.retriesLeft}/${state.friction.maxRetries}.`)
  }

  if (event === "SubagentStart") {
    const config = loadParallaxConfig(project.root)
    const state = configuredState(store, id, project.root, config)
    return hookContext("SubagentStart", `[parallax] Inherit session ${id}. ${protocolStatus(state, config).summary}`)
  }

  if (event === "PreCompact") {
    const config = loadParallaxConfig(project.root)
    const state = configuredState(store, id, project.root, config)
    return systemMessage(`[parallax] State persisted before compaction. ${protocolStatus(state, config).summary}`)
  }

  if (event === "Stop") {
    const result = persistTrace(store, id, project.root, false)
    if (!result) return systemMessage(`[parallax] No state found for session ${id}.`)
    return systemMessage(`[parallax] Trace checkpoint exported (session remains active): ${result.path}. Protocol epoch ${result.state.protocol.epoch}; retries ${result.state.friction.retriesLeft}/${result.state.friction.maxRetries}.`)
  }

  const result = persistTrace(store, id, project.root, true)
  if (!result) return systemMessage(`[parallax] No state found for session ${id}.`)
  return systemMessage(`[parallax] Final trace exported to ${result.path}. Writes ${result.state.trace.writes.length}; coherence ${result.state.trace.coherenceScore ?? 0}/100.`)
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main(): Promise<void> {
  const rawEvent = process.argv[2]
  if (!rawEvent || !EVENTS.has(rawEvent as ParallaxHookEvent)) throw new Error(`Unknown hook event: ${String(rawEvent)}`)
  output(await dispatchHook(rawEvent as ParallaxHookEvent, await readStdin()))
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // A broken mutation precondition must fail closed; observer hooks never hide Claude's result.
    if (process.argv[2] === "PreToolUse") output(deny(`[parallax] Session safety check failed: ${message}`))
    else output(systemMessage(`[parallax] Hook error: ${message}`))
    process.exitCode = 0
  })
}
