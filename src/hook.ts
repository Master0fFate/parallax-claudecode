#!/usr/bin/env node
import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { isAbsolute, relative, resolve } from "node:path"
import { applyParallaxConfig, loadParallaxConfig } from "./config.js"
import { detectProject } from "./detect.js"
import { VerificationLedger } from "./ledger.js"
import { MutationIntentQueue, type MutationClaim, type MutationObservation } from "./mutation-queue.js"
import { beginProtocolEpoch } from "./protocol.js"
import { createSessionState, SessionStore } from "./state.js"
import { HorizonStore } from "./horizon.js"
import { HorizonDispatchStore, type HorizonDispatchRole } from "./horizon-dispatch.js"
import { addWriteBatch, checkpointTrace, exportTrace, finalizeTrace } from "./trace.js"
import { runVerification } from "./verify.js"
import type { ClaudeHookInput, ParallaxConfig, ProtocolStep, SessionState, VerificationVerdict } from "./types.js"

/** Native Claude lifecycle events handled by the dispatcher. */
export type ParallaxHookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolBatch"
  | "PostToolUseFailure"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact"
  | "Stop"
  | "SessionEnd"

const EVENTS = new Set<ParallaxHookEvent>([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolBatch",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
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

function hookContext(event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostToolBatch" | "PostToolUseFailure" | "SubagentStart" | "SubagentStop", message: string): Record<string, unknown> {
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

const FAILURE_WORDS = /\b(?:denied|failed|failure|error|blocked|cancelled|canceled|rejected|permission denied)\b/i
const HORIZON_AGENT_TYPES = {
  "parallax-claudecode:horizon-worker": "worker",
  "parallax-claudecode:horizon-auditor": "auditor",
} as const
const HORIZON_SUPERVISOR = "parallax-claudecode:horizon"
const PARALLAX_MCP_PREFIX = "mcp__plugin_parallax-claudecode_parallax__"
const WORKER_MCP = new Set(["parallax_checkin", "parallax_verify", "parallax_trace_export"])
const AUDITOR_MCP = new Set(["horizon_read_plan", "horizon_read_state", "horizon_active_child", "parallax_trace_view"])
const HORIZON_DISPATCH_FORMAT = 'HORIZON_DISPATCH {"sessionId":"<horizon-session>","featureId":"<feature>"}'

function horizonRole(agentType: unknown): HorizonDispatchRole | null {
  return typeof agentType === "string" && agentType in HORIZON_AGENT_TYPES ? HORIZON_AGENT_TYPES[agentType as keyof typeof HORIZON_AGENT_TYPES] : null
}

function isHorizonSupervisor(agentType: unknown): boolean { return agentType === HORIZON_SUPERVISOR }

function hasDelegatedMarker(input: ClaudeHookInput): boolean {
  return input.agent_type !== undefined || input.agent_id !== undefined
}

function hasCompleteDelegatedIdentity(input: ClaudeHookInput): boolean {
  return typeof input.agent_type === "string" && input.agent_type.length > 0
    && typeof input.agent_id === "string" && input.agent_id.length > 0
}

function dispatchEnvelope(prompt: unknown): { sessionId: string; featureId: string } {
  if (typeof prompt !== "string") throw new Error("Horizon dispatch prompt is missing")
  const first = prompt.split(/\r?\n/, 1)[0] ?? ""
  if (!first.startsWith("HORIZON_DISPATCH ")) throw new Error(`Horizon worker dispatch requires the first prompt line: ${HORIZON_DISPATCH_FORMAT}. Do not dispatch a worker with only a human brief.`)
  const value: unknown = JSON.parse(first.slice("HORIZON_DISPATCH ".length))
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HORIZON_DISPATCH must be an object")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => key !== "sessionId" && key !== "featureId") || typeof record.sessionId !== "string" || typeof record.featureId !== "string") throw new Error("HORIZON_DISPATCH requires only sessionId and featureId")
  return { sessionId: record.sessionId, featureId: record.featureId }
}

function agentResult(input: ClaudeHookInput): { status: string | null; agentId: string | null } {
  let value: unknown = input.tool_response
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown } catch { return { status: null, agentId: null } } }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: null, agentId: null }
  const record = value as Record<string, unknown>
  return { status: typeof record.status === "string" ? record.status : null, agentId: typeof record.agentId === "string" ? record.agentId : typeof record.agent_id === "string" ? record.agent_id : null }
}

function boundedChildSummary(input: ClaudeHookInput): string {
  const value = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "Child stopped without a final summary."
  return value.replace(/\0/g, "").slice(0, 2_000)
}

function abortDispatch(dispatches: HorizonDispatchStore, horizon: HorizonStore, parentId: string, reason: string): void {
  const pending = dispatches.read(parentId)
  if (!pending) return
  if (pending.agentId) horizon.abortActiveChild(pending.horizonSessionId, pending.featureId, pending.agentId, reason.slice(0, 2_000))
  dispatches.release(parentId)
}

function quarantineDispatch(dispatches: HorizonDispatchStore, parentId: string, reason: string): void {
  if (dispatches.read(parentId)) dispatches.quarantine(parentId, reason)
}

type ToolOutcome = "success" | "failure" | "unknown"

function contentBlockOutcome(value: unknown): ToolOutcome {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown"
  const block = value as Record<string, unknown>
  if (typeof block.type !== "string" || !block.type) return "unknown"
  if (block.is_error === true || block.isError === true) return "failure"
  if (block.type === "text") {
    if (typeof block.text !== "string" || !block.text.trim()) return "unknown"
    return FAILURE_WORDS.test(block.text) ? "failure" : "success"
  }
  if (block.type === "tool_result") {
    if (typeof block.tool_use_id !== "string" || !("content" in block)) return "unknown"
    return responseOutcome(block.content)
  }
  if (block.type === "image" || block.type === "document") return block.source && typeof block.source === "object" ? "success" : "unknown"
  if (block.type === "thinking") return typeof block.thinking === "string" ? "success" : "unknown"
  if (block.type === "redacted_thinking") return typeof block.data === "string" ? "success" : "unknown"
  return "unknown"
}

/** Claude 2.1.215 documents only serialized strings and well-formed content-block arrays. */
function responseOutcome(value: unknown): ToolOutcome {
  if (typeof value === "string") {
    if (!value.trim()) return "unknown"
    return FAILURE_WORDS.test(value) ? "failure" : "success"
  }
  if (!Array.isArray(value) || !value.length) return "unknown"
  const outcomes = value.map(contentBlockOutcome)
  if (outcomes.includes("failure")) return "failure"
  return outcomes.every((outcome) => outcome === "success") ? "success" : "unknown"
}

function normalizedTarget(projectRoot: string, target: string): string {
  const absolute = resolve(projectRoot, target)
  const local = relative(projectRoot, absolute)
  return (local && !local.startsWith("..") && !isAbsolute(local) ? local : absolute).replaceAll("\\", "/")
}

function normalizedInput(projectRoot: string, tool: string, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizedInput(projectRoot, tool, item))
  if (!value || typeof value !== "object") return value
  const output: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key]
    const isPrimaryPath = (tool === "Write" || tool === "Edit") && key === "file_path"
      || tool === "NotebookEdit" && key === "notebook_path"
    output[key] = isPrimaryPath && typeof item === "string" ? normalizedTarget(projectRoot, item.trim()) : normalizedInput(projectRoot, tool, item)
  }
  return output
}

function mutationFingerprint(projectRoot: string, tool: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) throw new Error("mutation tool_input must be an object")
  return createHash("sha256").update(JSON.stringify({ tool, input: normalizedInput(projectRoot, tool, toolInput) })).digest("hex")
}

function mutationIntent(input: ClaudeHookInput, projectRoot: string, tool: string): { toolUseId: string; tool: string; fingerprint: string; targets: string[] } {
  if (typeof input.tool_use_id !== "string" || !input.tool_use_id.trim() || input.tool_use_id.length > 512) {
    throw new Error("mutation tool input requires a valid tool_use_id")
  }
  if (!input.tool_input || typeof input.tool_input !== "object" || Array.isArray(input.tool_input)) {
    throw new Error("mutation tool_input must be an object")
  }
  const record = input.tool_input as Record<string, unknown>
  const key = tool === "NotebookEdit" ? "notebook_path" : tool === "Write" || tool === "Edit" ? "file_path" : null
  const fingerprint = mutationFingerprint(projectRoot, tool, input.tool_input)
  if (!key) return { toolUseId: input.tool_use_id, tool, fingerprint, targets: [`<unknown:${tool}>`] }
  if (typeof record[key] !== "string" || !record[key].trim()) throw new Error(`${tool} requires ${key}`)
  return { toolUseId: input.tool_use_id, tool, fingerprint, targets: [normalizedTarget(projectRoot, record[key].trim())] }
}

function mutationObservation(call: Record<string, unknown>, projectRoot: string): MutationObservation | null {
  if (typeof call.tool_use_id !== "string" || !call.tool_use_id) return null
  const tool = typeof call.tool_name === "string" && MUTATION_TOOLS.has(call.tool_name) ? call.tool_name : null
  let fingerprint: string | null = null
  if (tool) {
    try { fingerprint = mutationFingerprint(projectRoot, tool, call.tool_input) }
    catch { fingerprint = null }
  }
  const outcome = Object.prototype.hasOwnProperty.call(call, "tool_response") ? responseOutcome(call.tool_response) : "unknown"
  return {
    toolUseId: call.tool_use_id, tool, fingerprint, outcome,
    detail: tool === null ? `tool ${String(call.tool_name)} did not match the durable intent`
      : fingerprint === null ? `tool_input for ${call.tool_use_id} was malformed`
        : outcome === "unknown" ? `tool_response for ${call.tool_use_id} was undocumented or ambiguous` : `${call.tool_use_id} ${outcome}`,
  }
}

function queueContext(queue: MutationIntentQueue): string {
  const state = queue.read()
  if (state.unresolved) return ` Reconciliation required for ${state.unresolved.toolUseIds.join(", ")}: ${state.unresolved.reason}.`
  if (state.active) return ` Active mutation verification claim ${state.active.id} retains ${state.active.intents.length} intent(s) until its lease can be safely recovered.`
  if (state.pending.length) return ` ${state.pending.length} mutation intent(s) await PostToolBatch evidence.`
  return " No mutation intents are outstanding."
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
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

function updateFriction(state: SessionState, verdict: VerificationVerdict, observation: string | null): void {
  state.friction.lastObservation = verdict === "fail" || verdict === "unknown" ? observation : null
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
  let horizonValue: HorizonStore | null = null
  const horizon = (): HorizonStore => horizonValue ??= new HorizonStore()
  const dispatches = new HorizonDispatchStore(project.root)

  if (event === "SessionStart") {
    const config = loadParallaxConfig(project.root)
    const state = store.update(id, (current) => {
      const next = applyParallaxConfig(current ?? createSessionState(id, store.projectRoot, config.maxRetries), config)
      next.trace.session.projectType = project.type
      return next
    })
    const queue = new MutationIntentQueue(project.root, id)
    if (input.source === "resume") queue.reconcileBoundary("Session resumed before durable mutation evidence was correlated")
    return hookContext("SessionStart", `[parallax] Session ${id} ready (${project.type ?? "unknown"}). ${protocolStatus(state, config).summary}${queueContext(queue)}`)
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
    const callerRole = horizonRole(input.agent_type)
    const supervisor = isHorizonSupervisor(input.agent_type)
    const delegated = hasDelegatedMarker(input)
    const completeIdentity = hasCompleteDelegatedIdentity(input)
    if (MUTATION_TOOLS.has(tool) && delegated) {
      if (!completeIdentity) return deny("[horizon] Mutation denied for a malformed partial delegated identity.")
      if (supervisor) return deny("[horizon] The Horizon supervisor is not authorized to use native mutation tools.")
      if (callerRole !== "worker") return deny("[horizon] Only the active, fully identified Horizon worker may use native mutation tools.")
      const pending = dispatches.read(id)
      const lock = pending ? horizon().readActiveChild(pending.horizonSessionId) : null
      if (!pending || pending.agentId !== input.agent_id || pending.role !== "worker" || !lock || lock.childRunId !== input.agent_id || lock.role !== "worker" || lock.featureId !== pending.featureId) {
        return deny("[horizon] Worker mutation authorization does not match the active feature and agent ID.")
      }
    }
    if (tool === "Agent") {
      if (callerRole) return deny(`[horizon] ${callerRole} children cannot delegate or orchestrate other agents.`)
      const toolInput = input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input) ? input.tool_input as Record<string, unknown> : null
      const requestedType = toolInput?.subagent_type
      const looksHorizon = typeof requestedType === "string" && requestedType.includes("horizon-")
        || typeof toolInput?.prompt === "string" && toolInput.prompt.startsWith("HORIZON_DISPATCH ")
      if (!looksHorizon) return hookContext("PreToolUse", "[parallax] Non-Horizon Agent dispatch; Horizon role gate not applicable.")
      if (delegated && (!completeIdentity || !supervisor)) {
        return deny("[horizon] Only the fully identified plugin-scoped Horizon supervisor or the true main thread may dispatch Horizon roles.")
      }
      const role = horizonRole(requestedType)
      if (!role) return deny("[horizon] Unknown or unscoped Horizon role. Use the exact plugin-scoped horizon-worker or horizon-auditor type.")
      if (!toolInput || typeof input.tool_use_id !== "string" || !input.tool_use_id) return deny("[horizon] Dispatch requires documented Agent input and a tool_use_id.")
      if (toolInput.run_in_background === true) return deny("[horizon] Background Horizon dispatch is forbidden; foreground completion evidence is required.")
      try {
        const envelope = dispatchEnvelope(toolInput.prompt)
        const plan = horizon().readPlan(envelope.sessionId)
        if (!plan) throw new Error(`Horizon session ${envelope.sessionId} was not found`)
        if (horizon().readActiveChild(envelope.sessionId)) throw new Error("Another Horizon child is already active")
        const features = [...plan.milestones].sort((a, b) => a.order - b.order).flatMap((milestone) => [...milestone.features].sort((a, b) => a.order - b.order))
        const feature = features.find((item) => item.id === envelope.featureId)
        if (!feature) throw new Error(`Feature ${envelope.featureId} was not found`)
        const firstOpen = features.find((item) => item.status !== "completed")
        if (firstOpen?.id !== feature.id) throw new Error(`Feature order requires ${firstOpen?.id ?? "no further feature"} before ${feature.id}`)
        if (role === "worker" && (feature.status !== "pending" || feature.evidence.worker.receipt !== null)) throw new Error("Worker dispatch requires a pending feature without a receipt")
        if (role === "auditor" && (!feature.evidence.worker.receipt || feature.evidence.auditor.childRunId !== null)) throw new Error("Auditor dispatch requires an observed receipt and no assigned auditor")
        dispatches.acquire({ parentSessionId: id, horizonSessionId: envelope.sessionId, featureId: envelope.featureId, role, toolUseId: input.tool_use_id })
        return hookContext("PreToolUse", `[horizon] ${role} dispatch reserved for ${envelope.sessionId}/${envelope.featureId}. Claude 2.1.215 has no official foreground Agent flag; only a later completed status will satisfy this gate.`)
      } catch (error) { return deny(`[horizon] Dispatch blocked: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (tool === `${PARALLAX_MCP_PREFIX}horizon_observe_receipt` || tool === `${PARALLAX_MCP_PREFIX}horizon_record_audit`) {
      const expectedRole = tool.endsWith("horizon_observe_receipt") ? "worker" : "auditor"
      const args = input.tool_input && typeof input.tool_input === "object" && !Array.isArray(input.tool_input) ? input.tool_input as Record<string, unknown> : {}
      try {
        if (args.parentSessionId !== id) throw new Error("transition parent session marker does not match the calling session")
        dispatches.requireCompleted(id, {
          horizonSessionId: typeof args.sessionId === "string" ? args.sessionId : "",
          featureId: typeof args.featureId === "string" ? args.featureId : "",
          role: expectedRole,
          childRunId: typeof args.childRunId === "string" ? args.childRunId : "",
        })
      } catch (error) {
        return deny(`[horizon] ${expectedRole} transition denied: ${error instanceof Error ? error.message : String(error)}.`)
      }
    }
    if (callerRole && completeIdentity && !MUTATION_TOOLS.has(tool)) {
      const pending = dispatches.read(id)
      const lock = pending ? horizon().readActiveChild(pending.horizonSessionId) : null
      if (!pending || pending.agentId !== input.agent_id || pending.role !== callerRole || !lock || lock.childRunId !== input.agent_id || lock.role !== callerRole || lock.featureId !== pending.featureId) {
        return deny("[horizon] Child tool authorization does not match the active feature, role, and agent ID.")
      }
    }
    if (tool.startsWith(PARALLAX_MCP_PREFIX) && delegated) {
      if (!completeIdentity) return deny("[horizon] Plugin Parallax MCP access denied for a malformed partial delegated identity.")
      if (supervisor) return hookContext("PreToolUse", "[horizon] Plugin-scoped supervisor MCP orchestration authorization passed.")
      if (!callerRole) return deny("[horizon] Plugin Parallax MCP access denied for an unknown child identity.")
      const name = tool.slice(PARALLAX_MCP_PREFIX.length)
      const allowed = callerRole === "worker" ? WORKER_MCP : AUDITOR_MCP
      if (!allowed.has(name)) return deny(`[horizon] ${callerRole} is not authorized for ${name}.`)
      const pending = dispatches.read(id)
      const lock = pending ? horizon().readActiveChild(pending.horizonSessionId) : null
      if (!pending || pending.agentId !== input.agent_id || pending.role !== callerRole || !lock || lock.childRunId !== input.agent_id || lock.role !== callerRole || lock.featureId !== pending.featureId) {
        return deny("[horizon] Child MCP authorization does not match the active feature, role, and agent ID.")
      }
      return hookContext("PreToolUse", `[horizon] Scoped ${callerRole} MCP authorization passed for ${pending.featureId}.`)
    }
    if (!MUTATION_TOOLS.has(tool)) return hookContext("PreToolUse", "[parallax] Non-mutation tool; protocol gate not applicable.")
    const config = loadParallaxConfig(project.root)
    const state = configuredState(store, id, project.root, config)
    const status = protocolStatus(state, config)
    if (status.missing.length) {
      return deny(`[parallax] Write blocked. Complete ${status.missing.join(" -> ")} with parallax_checkin for session ${id} and concrete evidence before ${tool}.`)
    }
    const queue = new MutationIntentQueue(project.root, id)
    const outstanding = queue.read()
    if (outstanding.active || outstanding.unresolved) {
      return deny(`[parallax] Write blocked until durable mutation evidence is reconciled.${queueContext(queue)}`)
    }
    if (state.friction.retriesLeft === 0) {
      if (state.friction.repairWritesRemaining === 0) {
        return deny(`[parallax] Write blocked after repeated verification failures. Run parallax_verify; a failing manual recovery check grants one bounded repair batch. ${state.friction.lastObservation ?? ""}`.trim())
      }
      // Consume the permit only after PostToolBatch proves at least one mutation succeeded.
      // Permission denial, cancellation, and tool failure therefore cannot strand recovery.
      try { queue.record(mutationIntent(input, project.root, tool)) }
      catch (error) { return deny(`[parallax] Write blocked because mutation intent could not be persisted: ${error instanceof Error ? error.message : String(error)}`) }
      return hookContext("PreToolUse", `[parallax] One-shot repair batch authorized after exhausted verification. Run parallax_verify immediately after the repair.`)
    }
    try { queue.record(mutationIntent(input, project.root, tool)) }
    catch (error) { return deny(`[parallax] Write blocked because mutation intent could not be persisted: ${error instanceof Error ? error.message : String(error)}`) }
    // No permissionDecision means Claude Code's normal permission flow remains authoritative.
    return hookContext("PreToolUse", `[parallax] Write gate passed. ${status.summary}`)
  }

  if (event === "PostToolUse") {
    if (input.tool_name === `${PARALLAX_MCP_PREFIX}horizon_recover_active_child`) {
      const pending = dispatches.read(id)
      if (!pending) return {}
      if (horizon().readActiveChild(pending.horizonSessionId)) return hookContext("PostToolUse", "[horizon] Recovery returned but the identity-bound active child lock remains; quarantine retained.")
      dispatches.release(id)
      return hookContext("PostToolUse", "[horizon] Dead-child recovery observed; quarantined dispatch reservation released.")
    }
    if (input.tool_name === `${PARALLAX_MCP_PREFIX}horizon_observe_receipt` || input.tool_name === `${PARALLAX_MCP_PREFIX}horizon_record_audit`) {
      const pending = dispatches.read(id)
      if (!pending) return {}
      if (horizon().readActiveChild(pending.horizonSessionId)) return hookContext("PostToolUse", "[horizon] Transition returned but the active child lock remains; dispatch state was preserved for reconciliation.")
      dispatches.release(id)
      return hookContext("PostToolUse", `[horizon] ${pending.role} transition observed; lifecycle dispatch reservation released.`)
    }
    if (input.tool_name !== "Agent") return {}
    const pending = dispatches.read(id)
    if (!pending) return {}
    const result = agentResult(input)
    if (input.tool_use_id !== pending.toolUseId) {
      quarantineDispatch(dispatches, id, `Agent result tool ID ${typeof input.tool_use_id === "string" ? input.tool_use_id : "missing"} did not match ${pending.toolUseId}`)
      return hookContext("PostToolUse", "[horizon] Dispatch rejected: Agent result did not match the reserved tool_use_id.")
    }
    if (!result.agentId || result.agentId !== pending.agentId) {
      quarantineDispatch(dispatches, id, "Agent result did not include the exact bound child ID")
      return hookContext("PostToolUse", "[horizon] Dispatch rejected: Agent result did not include the exact bound child ID.")
    }
    if (result.status !== "completed") {
      const reason = `Agent dispatch ended with status ${result.status ?? "unobserved"}`
      quarantineDispatch(dispatches, id, reason)
      return hookContext("PostToolUse", `[horizon] Dispatch quarantined: Agent status ${result.status ?? "missing"} is not completed. Claude has no supported foreground guarantee; any active child lock is retained until safe death reconciliation.`)
    }
    const updated = dispatches.observeAgentCompleted(id, result.agentId)
    return hookContext("PostToolUse", `[horizon] Observed Agent completed for ${pending.role} ${result.agentId}; lifecycle is ${updated.status}. Matching SubagentStop and the durable receipt/audit transition remain required.`)
  }

  if (event === "PostToolBatch") {
    // Claude 2.1.215 provides one official serialized response on each tool_calls entry.
    // Calls without a correlated durable PreToolUse intent can never become evidence.
    const queue = new MutationIntentQueue(project.root, id)
    if (!Array.isArray(input.tool_calls)) {
      const before = queue.read()
      if (!before.pending.length && !before.active && !before.unresolved) return {}
      queue.rejectEvidence("PostToolBatch tool_calls was missing or malformed")
      return hookContext("PostToolBatch", `[parallax] Batch evidence rejected; mutation intents were retained.${queueContext(queue)}`)
    }
    if (!input.tool_calls.length) {
      const before = queue.read()
      if (!before.pending.length && !before.active) return {}
      queue.rejectEvidence("PostToolBatch tool_calls was empty while durable mutation work remained")
      return hookContext("PostToolBatch", `[parallax] Batch evidence rejected; mutation intents were retained.${queueContext(queue)}`)
    }
    const malformedEntry = input.tool_calls.some((call) => !call || typeof call !== "object" || Array.isArray(call)
      || typeof call.tool_use_id !== "string" || !call.tool_use_id)
    const observations = input.tool_calls.flatMap((call) => {
      if (!call || typeof call !== "object" || Array.isArray(call)) return []
      const observation = mutationObservation(call as Record<string, unknown>, project.root)
      return observation ? [observation] : []
    })
    if (!observations.length && queue.read().pending.length === 0) return {}
    const config = loadParallaxConfig(project.root)
    const ledger = new VerificationLedger(project.root)
    const deadline = Date.now() + 165_000
    let last: { claim: MutationClaim; verification: Awaited<ReturnType<typeof runVerification>>; state: SessionState } | null = null

    while (true) {
      const acquired = queue.observe(observations, malformedEntry ? "PostToolBatch contained a malformed tool_calls entry" : null)
      if (acquired.status === "busy") {
        if (Date.now() >= deadline) return hookContext("PostToolBatch", "[parallax] Mutation verification remains durably queued behind an active verifier claim.")
        await delay(25)
        continue
      }
      if (acquired.status === "empty") break
      const claim = acquired.claim
      const files = [...new Set(claim.intents.flatMap((intent) => intent.targets))]
      const actualFiles = files.filter((file) => !file.startsWith("<unknown:"))
      const tools = [...new Set(claim.intents.map((intent) => intent.tool))]
      let verification = claim.receipt ?? ledger.read().find((record) => record.id === claim.id)
      if (!verification) {
        verification = await runVerification(project, actualFiles, { sessionId: id, source: "automatic", receiptId: claim.id })
        ledger.append(verification)
      }
      // Persist the receipt on the claim before touching trace/friction state. A crash at any
      // later point can replay this exact receipt and batch ID without duplicate evidence.
      if (!claim.receipt) queue.attachReceipt(claim.id, verification)
      const state = store.update(id, (current) => {
        const next = applyParallaxConfig(current ?? (() => { throw new Error(`Parallax session not initialized: ${id}`) })(), config)
        if (next.trace.writes.some((write) => write.batchId === claim.id)) return next
        next.trace.session.projectType = project.type
        if (next.friction.retriesLeft === 0 && next.friction.repairWritesRemaining > 0) next.friction.repairWritesRemaining = 0
        updateFriction(next, verification.verdict, (verification.stderr || verification.stdout).slice(-2_000))
        addWriteBatch(next.trace, files, tools.join("|") || "unknown", verification, next.friction.retriesLeft, claim.id)
        return next
      })
      queue.complete(claim.id)
      last = { claim, verification, state }
    }
    if (!last) {
      const remaining = queue.read()
      return remaining.unresolved
        ? hookContext("PostToolBatch", `[parallax] Batch evidence rejected; mutation intents were retained.${queueContext(queue)}`)
        : {}
    }
    const { claim, verification, state } = last
    const detail = verification.verdict === "pass" ? `passed (${verification.command})`
      : verification.verdict === "skipped" ? "skipped (no supported command)"
        : verification.verdict === "unknown" ? `indeterminate; ${state.friction.retriesLeft} retries remain`
          : `failed; ${state.friction.retriesLeft} retries remain`
    const recovery = verification.verdict === "fail"
      ? ` Recover: ${(verification.stderr || verification.stdout || "verification command failed").replace(/\s+/g, " ").slice(-400)}` : ""
    return hookContext("PostToolBatch", `[parallax] Batch verification ${detail}; recorded ${claim.intents.flatMap((intent) => intent.targets).length} path(s).${recovery}`)
  }

  if (event === "PostToolUseFailure") {
    if (input.tool_name === "Agent") {
      const pending = dispatches.read(id)
      if (!pending) return hookContext("PostToolUseFailure", `[horizon] Unreserved Agent failure observed: ${toolFailure(input).slice(0, 400)}`)
      const result = agentResult(input)
      const correlation = input.tool_use_id !== pending.toolUseId
        ? `tool_use_id ${typeof input.tool_use_id === "string" ? input.tool_use_id : "missing"} did not match ${pending.toolUseId}`
        : !result.agentId || result.agentId !== pending.agentId
          ? "response agent ID did not match the bound child"
          : `Agent tool failed: ${toolFailure(input)}`
      quarantineDispatch(dispatches, id, correlation)
      return hookContext("PostToolUseFailure", `[horizon] Agent dispatch failure quarantined; ${correlation.slice(0, 400)}.`)
    }
    const failure = toolFailure(input).replace(/\s+/g, " ").slice(-1_000)
    const files = collectWrittenPaths(input.tool_input)
    const tool = typeof input.tool_name === "string" ? input.tool_name : "unknown"
    if (typeof input.tool_use_id === "string" && input.tool_use_id) {
      const observation = mutationObservation({ ...input, tool_response: input.tool_response ?? input.error ?? "failed" }, project.root)
      if (observation) new MutationIntentQueue(project.root, id).observe([{ ...observation, outcome: "failure", detail: failure }])
    }
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
    const role = horizonRole(input.agent_type)
    if (!role) return hookContext("SubagentStart", `[parallax] Unscoped subagent ${String(input.agent_type ?? "unknown")}; Horizon lifecycle not applicable.`)
    if (typeof input.agent_id !== "string" || !input.agent_id) throw new Error("Horizon SubagentStart requires documented agent_id")
    const pending = dispatches.read(id)
    if (!pending || pending.role !== role) throw new Error("Horizon SubagentStart did not match a reserved role")
    dispatches.bind(id, input.agent_id)
    try {
      if (role === "worker") horizon().beginWorker(pending.horizonSessionId, pending.featureId, input.agent_id)
      else horizon().beginAuditor(pending.horizonSessionId, pending.featureId, input.agent_id)
    } catch (error) { dispatches.release(id); throw error }
    const config = loadParallaxConfig(project.root); const state = configuredState(store, id, project.root, config)
    return hookContext("SubagentStart", `[horizon] Bound ${role} ${input.agent_id} to ${pending.horizonSessionId}/${pending.featureId}. Keep the final summary within 2,000 characters. ${protocolStatus(state, config).summary}`)
  }

  if (event === "SubagentStop") {
    const role = horizonRole(input.agent_type)
    if (!role) return hookContext("SubagentStop", "[parallax] Non-Horizon subagent stopped.")
    if (typeof input.agent_id !== "string" || !input.agent_id) throw new Error("Horizon SubagentStop requires documented agent_id")
    const pending = dispatches.read(id)
    if (!pending || pending.role !== role || pending.agentId !== input.agent_id) throw new Error("Horizon SubagentStop identity did not match the active dispatch")
    const failed = input.error !== undefined || typeof input.source === "string" && FAILURE_WORDS.test(input.source)
    const summary = boundedChildSummary(input)
    horizon().saveTrace(pending.horizonSessionId, input.agent_id, {
      schemaVersion: 1, role, featureId: pending.featureId, agentId: input.agent_id,
      transcriptPath: typeof input.agent_transcript_path === "string" ? input.agent_transcript_path : null,
      summary, outcome: failed ? "failure" : "completed", observedAt: new Date().toISOString(),
    })
    if (failed) {
      abortDispatch(dispatches, horizon(), id, `${role} stopped with failure: ${summary}`)
      return hookContext("SubagentStop", `[horizon] ${role} failure archived and active state reconciled.`)
    }
    const updated = dispatches.observeStop(id, input.agent_id)
    return hookContext("SubagentStop", `[horizon] ${role} stop archived; lifecycle is ${updated.status} and the lock is preserved until dual lifecycle evidence plus the receipt/audit transition. Summary: ${summary.slice(0, 400)}`)
  }

  if (event === "PreCompact" || event === "PostCompact") {
    const config = loadParallaxConfig(project.root)
    configuredState(store, id, project.root, config)
    const queue = new MutationIntentQueue(project.root, id)
    queue.reconcileBoundary(`${event} occurred before durable mutation evidence was correlated`)
    const result = persistTrace(store, id, project.root, false)
    if (!result) return systemMessage(`[parallax] No state found for session ${id}.`)
    return systemMessage(`[parallax] State hydrated and checkpointed ${event === "PreCompact" ? "before" : "after"} compaction. ${protocolStatus(result.state, config).summary}${queueContext(queue)}`)
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
