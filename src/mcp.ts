#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { checkIn } from "./protocol.js"
import { applyParallaxConfig, loadParallaxConfig } from "./config.js"
import { detectProject } from "./detect.js"
import { featureVerificationDigest, HorizonStore } from "./horizon.js"
import {
  assessComplexity,
  generateAllCrossAttacks,
  generateDefensePrompt,
  generateHyperplan,
  synthesizeInsightBundle,
} from "./hyperplan.js"
import { computeCoherenceScore } from "./score.js"
import { SessionStore, validateSessionState } from "./state.js"
import { addPhase, checkpointTrace, exportTrace, invalidateTrace } from "./trace.js"
import { runVerification } from "./verify.js"
import type {
  AgentMode,
  HorizonAutonomyLevel,
  HorizonConfig,
  HorizonDecision,
  HorizonFeature,
  HorizonItemStatus,
  HorizonPlan,
  HorizonState,
  HyperplanCritique,
  ProtocolStep,
  SessionState,
} from "./types.js"

const MCP_PROTOCOL_VERSION = "2024-11-05"
const SESSION_DESCRIPTION = "Claude session ID. Always pass it when known. If omitted, the sole stored session is used; multiple sessions produce an ambiguity error."
const HORIZON_SESSION_DESCRIPTION = "Horizon session ID. Always pass it when known. If omitted, the sole Horizon session is used; multiple sessions produce an ambiguity error."
const ITEM_STATUSES = ["pending", "in_progress", "completed", "failed"] as const
const MODES: AgentMode[] = ["plan", "build", "debug", "horizon"]

interface ToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<string> | string
}

export interface McpServerOptions {
  projectRoot?: string
  horizonRoot?: string
}

function object(value: unknown, label = "value"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringArg(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = args[key]
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`Missing required argument '${key}'`)
    return undefined
  }
  if (typeof value !== "string") throw new Error(`Argument '${key}' must be a string`)
  return value
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Argument '${key}' must be a finite number`)
  return value
}

function booleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== "boolean") throw new Error(`Argument '${key}' must be a boolean`)
  return value
}

function jsonArg(args: Record<string, unknown>, key: string, required = true): unknown {
  const value = args[key]
  if (value === undefined) {
    if (required) throw new Error(`Missing required argument '${key}'`)
    return undefined
  }
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown }
  catch (error) { throw new Error(`Argument '${key}' must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`) }
}

function schema(properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false }
}

function sessionProperty(horizon = false): Record<string, unknown> {
  return { type: "string", description: horizon ? HORIZON_SESSION_DESCRIPTION : SESSION_DESCRIPTION }
}

function textResult(text: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] }
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length)}\n[truncated at ${length} characters]`
}

export class ParallaxMcpServer {
  readonly projectRoot: string
  readonly sessions: SessionStore
  readonly horizon: HorizonStore
  readonly tools: Map<string, ToolDefinition>

  constructor(options: McpServerOptions = {}) {
    const requestedRoot = resolve(options.projectRoot ?? process.env.CLAUDE_PROJECT_DIR ?? process.env.PARALLAX_PROJECT_ROOT ?? process.cwd())
    const detectedRoot = detectProject(requestedRoot).root
    this.sessions = new SessionStore(detectedRoot)
    this.projectRoot = this.sessions.projectRoot
    this.horizon = new HorizonStore(options.horizonRoot)
    this.tools = new Map(this.createTools().map((tool) => [tool.name, tool]))
  }

  listTools(): Array<Pick<ToolDefinition, "name" | "description" | "inputSchema">> {
    return [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }

  async callTool(name: string, rawArgs: unknown = {}): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return textResult(`Unknown Parallax tool '${name}'. Call tools/list to see available tools.`, true)
    try {
      const args = rawArgs === undefined ? {} : object(rawArgs, "tool arguments")
      return textResult(await tool.execute(args))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return textResult(`[${name}] ERROR: ${message}`, true)
    }
  }

  async handleRequest(request: unknown): Promise<Record<string, unknown> | null> {
    const value = object(request, "JSON-RPC request")
    const method = stringArg(value, "method")!
    const id = value.id
    if (method.startsWith("notifications/")) return null
    if (method === "initialize") {
      return { jsonrpc: "2.0", id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "parallax-claudecode", version: "0.1.0" } } }
    }
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} }
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: this.listTools() } }
    if (method === "tools/call") {
      const params = object(value.params, "tools/call params")
      const name = stringArg(params, "name")!
      return { jsonrpc: "2.0", id, result: await this.callTool(name, params.arguments ?? {}) }
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }
  }

  private availableCoreSessions(): string[] {
    const ids = new Set<string>()
    try {
      for (const entry of readdirSync(this.sessions.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const statePath = resolve(this.sessions.root, entry.name, "state.json")
        if (!existsSync(statePath)) continue // lock/reclaim directories are not sessions
        try {
          const value: unknown = JSON.parse(readFileSync(statePath, "utf8"))
          const state = validateSessionState(value)
          // Use SessionStore.read as the canonical-root and storage-key authority too.
          if (!this.sessions.read(state.sessionId)) throw new Error("Session state is stored under a mismatched storage key")
          ids.add(state.sessionId)
        } catch (error) {
          throw new Error(`Corrupt implicit Parallax session at ${statePath}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return [...ids].sort()
  }

  private resolveCoreSession(args: Record<string, unknown>): { id: string; state: SessionState } {
    const explicit = stringArg(args, "sessionId", false)
    if (explicit) {
      const state = this.sessions.read(explicit)
      if (!state) throw new Error(`Parallax session '${explicit}' was not found under ${this.sessions.root}. Start that Claude session first or pass a valid sessionId.`)
      return { id: explicit, state }
    }
    const ids = this.availableCoreSessions()
    if (ids.length === 0) throw new Error(`No Parallax sessions were found under ${this.sessions.root}. Start a Claude Code session so the SessionStart hook initializes it, then pass its sessionId.`)
    if (ids.length > 1) throw new Error(`sessionId is required because ${ids.length} Parallax sessions are available: ${ids.join(", ")}. Retry with the intended sessionId.`)
    const id = ids[0]!
    const state = this.sessions.read(id)
    if (!state) throw new Error(`Parallax session '${id}' disappeared while resolving it; retry with an explicit sessionId.`)
    return { id, state }
  }

  private resolveHorizonSession(args: Record<string, unknown>): string {
    const explicit = stringArg(args, "sessionId", false)
    if (explicit) {
      if (!this.horizon.readPlan(explicit)) throw new Error(`Horizon session '${explicit}' was not found. Call horizon_list_sessions or initialize it with horizon_init_session.`)
      return explicit
    }
    const ids = this.horizon.listSessions().map((entry) => entry.id)
    if (ids.length === 0) throw new Error("No Horizon sessions exist. Call horizon_init_session with an explicit sessionId first.")
    if (ids.length > 1) throw new Error(`sessionId is required because ${ids.length} Horizon sessions are available: ${ids.join(", ")}. Retry with the intended sessionId.`)
    return ids[0]!
  }

  private updateCore(id: string, update: (state: SessionState) => void): SessionState {
    return this.sessions.update(id, (state) => {
      if (!state) throw new Error(`Parallax session '${id}' no longer exists`)
      update(state)
      return state
    })
  }

  private createTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = []
    const add = (tool: ToolDefinition): void => { tools.push(tool) }
    const modeTool = (name: string, mode: AgentMode, description: string): void => add({
      name, description,
      inputSchema: schema({ sessionId: sessionProperty() }),
      execute: (args) => {
        const { id } = this.resolveCoreSession(args)
        this.updateCore(id, (state) => { state.mode = mode; addPhase(state.trace, "mode_switch", { mode }) })
        return `[parallax] ${mode.toUpperCase()} mode activated for session ${id}.`
      },
    })

    add({
      name: "parallax_verify",
      description: "Run project-aware verification and record the result in the selected Claude session trace.",
      inputSchema: schema({ sessionId: sessionProperty(), thorough: { type: "boolean", description: "Run every detected check rather than only the first." }, files: { type: "array", items: { type: "string" } } }),
      execute: async (args) => {
        const { id } = this.resolveCoreSession(args)
        const config = loadParallaxConfig(this.projectRoot)
        const state = this.updateCore(id, (next) => { applyParallaxConfig(next, config) })
        const exhausted = state.friction.retriesLeft === 0
        if (exhausted && state.friction.recoveryAttempts >= config.maxRecoveryAttempts) throw new Error(`Exhausted-friction recovery cap reached (${config.maxRecoveryAttempts} attempts). Fix the underlying detected command outside mutation flow or start a new task epoch.`)
        const files = args.files === undefined ? [] : Array.isArray(args.files) && args.files.every((item) => typeof item === "string") ? args.files as string[] : (() => { throw new Error("Argument 'files' must be a string array") })()
        const thorough = booleanArg(args, "thorough")
        // Never trust persisted cwd for command execution. Verification is bound to the
        // canonical project root selected when this server/store was constructed.
        const result = await runVerification(detectProject(this.projectRoot), files, thorough === undefined ? {} : { thorough })
        this.updateCore(id, (next) => {
          applyParallaxConfig(next, config)
          invalidateTrace(next.trace)
          next.trace.verifications.push(result)
          if (result.verdict !== "skipped") {
            next.friction.trials += 1
            if (result.verdict === "pass") { next.friction.successes += 1; next.friction.consecutiveFailures = 0; next.friction.retriesLeft = next.friction.maxRetries; next.friction.recoveryAttempts = 0; next.friction.repairWritesRemaining = 0; next.friction.lastObservation = null }
            else {
              next.friction.consecutiveFailures += 1
              next.friction.retriesLeft = Math.max(0, next.friction.maxRetries - next.friction.consecutiveFailures)
              if (exhausted) {
                next.friction.recoveryAttempts += 1
                next.friction.repairWritesRemaining = 1
              }
              next.friction.lastObservation = (result.stderr || result.stdout).slice(-2_000)
            }
          }
        })
        const output = result.verdict === "pass" ? result.stdout : result.stderr || result.stdout
        const recovery = exhausted && result.verdict === "fail" ? "\nOne bounded repair mutation is now authorized; repair the failure, then verify again." : ""
        return `[parallax] VERIFICATION ${result.verdict.toUpperCase()}${result.exitCode === null ? "" : ` (exit ${result.exitCode})`}\nCommand: ${result.command ?? "none"}${recovery}\n${truncate(output, 4_000)}`.trim()
      },
    })

    add({
      name: "parallax_analyze",
      description: "Record and return a structured multi-perspective edge-case analysis framework before implementation.",
      inputSchema: schema({ sessionId: sessionProperty(), topic: { type: "string", minLength: 1 } }, ["topic"]),
      execute: (args) => {
        const topic = stringArg(args, "topic")!
        const { id } = this.resolveCoreSession(args)
        this.updateCore(id, (state) => addPhase(state.trace, "mode_switch", { analysisTopic: topic }))
        return `[parallax] ANALYSIS FRAMEWORK: ${topic}\n\nNOMINAL CASE: define observable success.\nEDGE CASES: null/empty inputs; boundaries; failures; concurrency; interruption; security; compatibility.\nCROSS-CUTTING: error clarity; observability; performance; testability; rollback.\nInvestigate the codebase and turn each applicable concern into a verification criterion.`
      },
    })

    add({
      name: "parallax_checkin",
      description: "Mark one ordered Parallax protocol step complete with concrete evidence.",
      inputSchema: schema({ sessionId: sessionProperty(), step: { type: "string", enum: ["ambiguity", "invariants", "gate", "design", "commit", "summary"] }, evidence: { type: "string", minLength: 8 } }, ["step", "evidence"]),
      execute: (args) => {
        const step = stringArg(args, "step") as ProtocolStep
        const evidence = stringArg(args, "evidence")!
        const { id } = this.resolveCoreSession(args)
        const state = this.updateCore(id, (next) => checkIn(next, step, evidence))
        if (step !== "summary") return `[parallax] ${step} marked complete for session ${id}.`
        const score = computeCoherenceScore(state.trace)
        return `[parallax] Protocol complete for session ${id}. Coherence score: ${score.total}/100; writes: ${state.trace.writes.length}; verifications: ${state.trace.verifications.length}.`
      },
    })

    modeTool("parallax_plan", "plan", "Switch the selected session to precision planning mode.")
    modeTool("parallax_build", "build", "Switch the selected session to implementation mode.")
    modeTool("parallax_debug", "debug", "Switch the selected session to audit and debugging mode.")
    modeTool("parallax_horizon", "horizon", "Switch the selected Claude session to long-horizon orchestration mode.")

    add({
      name: "parallax_hyperplan",
      description: "Generate, cross-attack, defend, or synthesize multi-perspective adversarial plan critiques.",
      inputSchema: schema({
        mode: { type: "string", enum: ["generate", "synthesize"] }, round: { type: "string", enum: ["analysis", "cross-attack", "defense"] },
        plan: { type: "string" }, angles: { description: "JSON array or array of built-in angle IDs", anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] }, force: { type: "boolean" },
        critiques: { description: "JSON string or array of critique objects" }, findings: { description: "JSON string or array of Round 1 findings" }, attacks: { description: "JSON string or object mapping angle IDs to attacks" }, context: { type: "string" },
      }, ["mode", "plan"]),
      execute: (args) => this.executeHyperplan(args),
    })

    add({
      name: "parallax_trace_export",
      description: "Export the selected session's structured trace to .parallax/traces.",
      inputSchema: schema({ sessionId: sessionProperty(), pretty: { type: "boolean", description: "Accepted for OpenCode compatibility; exports are always formatted." } }),
      execute: (args) => {
        const { id } = this.resolveCoreSession(args)
        const result = this.sessions.finalize(id, (state) => {
          checkpointTrace(state.trace, state.friction.maxRetries)
          return { state, path: exportTrace(state.trace, this.projectRoot) }
        })
        if (!result) throw new Error(`Parallax session '${id}' no longer exists`)
        return `[parallax] Trace exported: ${result.path}\nSession: ${id}\nPhases: ${result.state.trace.phases.length}, Writes: ${result.state.trace.writes.length}\nCoherence Score: ${result.state.trace.coherenceScore}/100`
      },
    })

    add({
      name: "parallax_trace_pr_comment",
      description: "Generate a Markdown PR summary from the selected session trace.",
      inputSchema: schema({ sessionId: sessionProperty() }),
      execute: (args) => this.tracePrComment(this.resolveCoreSession(args)),
    })

    add({
      name: "parallax_trace_view",
      description: "Display protocol progress, coherence, friction, and writes for the selected session.",
      inputSchema: schema({ sessionId: sessionProperty() }),
      execute: (args) => this.traceView(this.resolveCoreSession(args)),
    })

    add({
      name: "parallax_health",
      description: "Validate and inspect persisted state for a selected Claude session and report MCP server health.",
      inputSchema: schema({ sessionId: sessionProperty() }),
      execute: (args) => {
        const { id, state } = this.resolveCoreSession(args)
        const score = computeCoherenceScore(state.trace)
        return [`## Parallax Health Check`, ``, `**Verdict:** HEALTHY`, `**Session ID:** \`${id}\``, `**Project root:** ${this.projectRoot}`, `**State file:** ${this.sessions.pathFor(id)}`, `**Mode:** ${state.mode}`, `**Schema:** ${state.schemaVersion}`, `**Coherence:** ${score.total}/100`, `**Retries remaining:** ${state.friction.retriesLeft}`, `**MCP tools:** ${this.tools.size}`].join("\n")
      },
    })

    this.addHorizonTools(add)
    return tools
  }

  private executeHyperplan(args: Record<string, unknown>): string {
    const mode = stringArg(args, "mode")!
    const plan = stringArg(args, "plan")!
    let customAngles: string[] | undefined
    if (args.angles !== undefined) {
      const parsed = jsonArg(args, "angles")
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) throw new Error("angles must be an array of string IDs")
      customAngles = parsed
    }
    if (mode === "synthesize") {
      const parsed = jsonArg(args, "critiques")
      if (!Array.isArray(parsed)) throw new Error("critiques must be an array")
      return `[hyperplan] INSIGHT BUNDLE SYNTHESIS\n\n${synthesizeInsightBundle(plan, parsed as HyperplanCritique[])}`
    }
    if (mode !== "generate") throw new Error(`Unknown mode '${mode}'; use generate or synthesize`)
    const round = stringArg(args, "round", false) ?? "analysis"
    const options = { ...(customAngles ? { customAngles } : {}), force: booleanArg(args, "force") === true, ...(stringArg(args, "context", false) ? { extraContext: stringArg(args, "context", false)! } : {}) }
    const generated = generateHyperplan(plan, options)
    if (round === "analysis") {
      if (generated.skipped) return `[hyperplan] TRIVIAL PLAN -- SKIPPING\nReason: ${generated.reason}\nComplexity score: ${assessComplexity(plan).score}\nSet force=true to run it anyway.`
      return `[hyperplan] ROUND 1: ANALYSIS\nComplexity: ${generated.complexity.toUpperCase()} (score: ${assessComplexity(plan).score})\nAngles: ${generated.angles.length}\n\n${generated.prompts.map((prompt, index) => `=== ${generated.angles[index]!.name} (${prompt.angleId}) ===\n${prompt.prompt}`).join("\n\n")}`
    }
    if (generated.angles.length === 0) throw new Error("No angles are available; use force=true or run a non-trivial plan")
    if (round === "cross-attack") {
      const findings = jsonArg(args, "findings")
      if (!Array.isArray(findings)) throw new Error("findings must be an array")
      return `[hyperplan] ROUND 2: CROSS-ATTACK\n\n${generateAllCrossAttacks(generated.angles, findings as Array<{ angleId: string; angleName: string; findings: string }>).map((item) => `=== ${item.angleId} ===\n${item.prompt}`).join("\n\n")}`
    }
    if (round === "defense") {
      const attacks = object(jsonArg(args, "attacks"), "attacks")
      const prompts = generated.angles.flatMap((angle) => {
        const values = attacks[angle.id]
        if (!Array.isArray(values)) return []
        return [`=== ${angle.id} ===\n${generateDefensePrompt(angle, values as Array<{ targetFinding: string; attackerName: string; attack: string; severity: string }>)}`]
      })
      if (!prompts.length) throw new Error("No defense prompts generated; attacks keys must match selected angle IDs")
      return `[hyperplan] ROUND 3: DEFENSE & REFINEMENT\n\n${prompts.join("\n\n")}`
    }
    throw new Error(`Unknown round '${round}'; use analysis, cross-attack, or defense`)
  }

  private tracePrComment({ id, state }: { id: string; state: SessionState }): string {
    const score = computeCoherenceScore(state.trace)
    const pass = state.trace.writes.filter((write) => write.verification === "pass").length
    const fail = state.trace.writes.filter((write) => write.verification === "fail").length
    const phases = state.trace.phases.filter((phase) => !["execution", "mode_switch"].includes(phase.phase)).map((phase) => `- [x] ${phase.phase.replace(/_/g, " ")}`).join("\n") || "- No phases recorded"
    const writes = state.trace.writes.slice(0, 20).map((write) => `- ${write.verification === "pass" ? "[OK]" : write.verification === "fail" ? "[FAIL]" : "[SKIP]"} \`${write.file}\``).join("\n") || "- No writes recorded"
    return [`## Parallax Trace`, ``, `| Metric | Value |`, `|---|---|`, `| Coherence | **${score.total}/100** |`, `| Protocol | ${score.protocolCoverage}/30 |`, `| Verification | ${score.verificationIntegrity}/35 |`, ``, `**Session:** \`${id}\``, ``, `### Protocol Phases`, phases, ``, `### Verification`, `${pass} passed, ${fail} failed`, ``, `### Files Changed`, writes].join("\n")
  }

  private traceView({ id, state }: { id: string; state: SessionState }): string {
    const score = computeCoherenceScore(state.trace)
    const progress = Object.entries(state.protocol.completed).map(([step, done]) => `- [${done ? "x" : " "}] ${step}${state.protocol.evidence[step as ProtocolStep] ? ` — ${state.protocol.evidence[step as ProtocolStep]}` : ""}`).join("\n")
    const writes = state.trace.writes.slice(-30).map((write) => `- ${write.verification.toUpperCase()} | ${write.file} | retries left ${write.frictionRetriesLeft}`).join("\n") || "No writes recorded."
    return [`## Parallax Session Trace`, `**Session:** \`${id}\``, `**Mode:** ${state.mode.toUpperCase()}`, `**Coherence:** ${score.total}/100`, ``, `### Protocol`, progress, ``, `### Friction`, `${state.friction.successes}/${state.friction.trials} successful; ${state.friction.retriesLeft} retries remain`, ``, `### Writes`, writes].join("\n")
  }

  private addHorizonTools(add: (tool: ToolDefinition) => void): void {
    const hSchema = (properties: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> => schema({ sessionId: sessionProperty(true), ...properties }, required)
    const resolveId = (args: Record<string, unknown>): string => this.resolveHorizonSession(args)

    add({ name: "horizon_init_session", description: "Initialize a durable Horizon session, plan, orchestration state, and artifact directories.", inputSchema: schema({ sessionId: { type: "string", description: "New explicit Horizon session ID." }, goal: { type: "string" }, autonomyLevel: { type: "string", enum: ["full", "semi", "supervised"] } }, ["sessionId", "goal"]), execute: (args) => {
      const id = stringArg(args, "sessionId")!
      const goal = stringArg(args, "goal")!
      const level = (stringArg(args, "autonomyLevel", false) ?? this.horizon.loadConfig().autonomyLevel) as HorizonAutonomyLevel
      this.horizon.initSession(id, goal, level)
      return `[horizon] Session initialized: ${id}\nGoal: ${truncate(goal, 120)}\nAutonomy: ${level}`
    } })

    add({ name: "horizon_write_plan", description: "Validate and write the full Horizon plan.", inputSchema: hSchema({ planJson: { description: "Full plan object or JSON string." } }, ["planJson"]), execute: (args) => {
      const id = resolveId(args)
      const value = object(jsonArg(args, "planJson"), "planJson")
      const plan = this.horizon.writePlan(id, { ...value, sessionId: id })
      return `[horizon] Plan written for ${id}: ${plan.milestones.length} milestones, ${plan.stats.totalFeatures} features.`
    } })

    add({ name: "horizon_read_plan", description: "Read the complete Horizon plan and progress.", inputSchema: hSchema(), execute: (args) => {
      const id = resolveId(args); const plan = this.horizon.readPlan(id)!
      return `[horizon] Plan for ${id}\nStatus: ${plan.status}\nProgress: ${plan.stats.completedFeatures}/${plan.stats.totalFeatures}\n\n${JSON.stringify(plan, null, 2)}`
    } })

    add({ name: "horizon_update_feature", description: "Update a feature status, sub-agent ID, and attempt count with retry-cap enforcement.", inputSchema: hSchema({ featureId: { type: "string" }, status: { type: "string", enum: ITEM_STATUSES }, subAgentSessionId: { type: "string" } }, ["featureId", "status"]), execute: (args) => {
      const id = resolveId(args); const featureId = stringArg(args, "featureId")!; const status = stringArg(args, "status") as HorizonItemStatus
      if (!ITEM_STATUSES.includes(status)) throw new Error(`Invalid status '${status}'`)
      const updates: Partial<HorizonFeature> = { status }
      const subAgentSessionId = stringArg(args, "subAgentSessionId", false); if (subAgentSessionId) updates.subAgentSessionId = subAgentSessionId
      const plan = this.horizon.updateFeature(id, featureId, updates); if (!plan) throw new Error(`Feature '${featureId}' was not found in session ${id}`)
      return `[horizon] Feature '${featureId}' updated to '${status}'. Progress: ${plan.stats.completedFeatures}/${plan.stats.totalFeatures}.`
    } })

    add({ name: "horizon_update_milestone", description: "Update a Horizon milestone status.", inputSchema: hSchema({ milestoneId: { type: "string" }, status: { type: "string", enum: ITEM_STATUSES } }, ["milestoneId", "status"]), execute: (args) => {
      const id = resolveId(args); const milestoneId = stringArg(args, "milestoneId")!; const status = stringArg(args, "status") as HorizonItemStatus
      if (!ITEM_STATUSES.includes(status)) throw new Error(`Invalid status '${status}'`)
      if (!this.horizon.updateMilestone(id, milestoneId, status)) throw new Error(`Milestone '${milestoneId}' was not found in session ${id}`)
      return `[horizon] Milestone '${milestoneId}' updated to '${status}'.`
    } })

    add({ name: "horizon_write_state", description: "Merge and validate Horizon orchestration state, updating its checkpoint.", inputSchema: hSchema({ stateJson: { description: "Partial state object or JSON string." } }, ["stateJson"]), execute: (args) => {
      const id = resolveId(args); const current = this.horizon.readState(id)!; const updates = object(jsonArg(args, "stateJson"), "stateJson")
      const state = this.horizon.writeState(id, { ...current, ...updates, sessionId: id })
      return `[horizon] State updated for ${id}. Phase: ${state.currentPhase}.`
    } })

    add({ name: "horizon_read_state", description: "Read current Horizon phase, active work, checkpoint, and pause state.", inputSchema: hSchema(), execute: (args) => {
      const id = resolveId(args); const state = this.horizon.readState(id)!
      return `[horizon] State for ${id}\nPhase: ${state.currentPhase}\nActive sub-agents: ${state.activeSubAgents.length}\nCurrent milestone: ${state.currentMilestoneId ?? "none"}\nCurrent feature: ${state.currentFeatureId ?? "none"}\nCheckpoint: ${state.lastCheckpoint}\n${state.pausedAt ? `Paused: ${state.pauseReason ?? "unknown"}` : "Not paused"}`
    } })

    add({ name: "horizon_append_decision", description: "Append a validated autonomous decision to decisions.jsonl.", inputSchema: hSchema({ feature: { type: "string" }, ambiguity: { type: "string" }, researchResult: { type: "string" }, decision: { type: "string" }, rationale: { type: "string" }, confidence: { type: "string", enum: ["high", "medium", "low"] } }, ["feature", "ambiguity", "researchResult", "decision", "rationale"]), execute: (args) => {
      const id = resolveId(args)
      const decision: HorizonDecision = { timestamp: new Date().toISOString(), feature: stringArg(args, "feature")!, ambiguity: stringArg(args, "ambiguity")!, researchResult: stringArg(args, "researchResult")!, decision: stringArg(args, "decision")!, rationale: stringArg(args, "rationale")!, confidence: (stringArg(args, "confidence", false) ?? "medium") as HorizonDecision["confidence"] }
      this.horizon.appendDecision(id, decision); return `[horizon] Decision logged for '${decision.feature}': ${truncate(decision.decision, 100)}`
    } })

    add({ name: "horizon_read_decisions", description: "Read the chronological Horizon decision log.", inputSchema: hSchema(), execute: (args) => {
      const id = resolveId(args); const decisions = this.horizon.readDecisions(id)
      return decisions.length ? `[horizon] Decisions for ${id} (${decisions.length})\n${decisions.map((item, index) => `${index + 1}. [${item.confidence}] ${item.feature}: ${item.decision}`).join("\n")}` : `[horizon] No decisions logged for ${id}.`
    } })

    add({ name: "horizon_write_research", description: "Persist research findings and source references.", inputSchema: hSchema({ findings: { type: "string" }, sourcesJson: { description: "Object or JSON string mapping labels to URLs." } }, ["findings"]), execute: (args) => {
      const id = resolveId(args); const findings = stringArg(args, "findings")!; const parsed = jsonArg(args, "sourcesJson", false); const sources = parsed === undefined ? {} : object(parsed, "sourcesJson")
      if (!Object.values(sources).every((item) => typeof item === "string")) throw new Error("sourcesJson values must all be strings")
      this.horizon.writeResearch(id, findings, sources as Record<string, string>); return `[horizon] Research written for ${id}: ${findings.length} characters, ${Object.keys(sources).length} sources.`
    } })

    add({ name: "horizon_read_research", description: "Read cached Horizon findings and sources.", inputSchema: hSchema(), execute: (args) => {
      const id = resolveId(args); const research = this.horizon.readResearch(id)
      return !research.findings && !Object.keys(research.sources).length ? `[horizon] No research found for ${id}.` : `[horizon] Research for ${id}\n\n${truncate(research.findings ?? "", 4_000)}\n\nSources:\n${Object.entries(research.sources).map(([key, value]) => `${key}: ${value}`).join("\n")}`
    } })

    add({ name: "horizon_create_skill", description: "Create and register a safe session-scoped Claude skill.", inputSchema: hSchema({ name: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }, description: { type: "string" }, content: { type: "string" } }, ["name", "description", "content"]), execute: (args) => {
      const id = resolveId(args); const name = stringArg(args, "name")!; const path = this.horizon.createSkill(id, name, stringArg(args, "description")!, stringArg(args, "content")!); return `[horizon] Skill created: ${name}\nPath: ${path}`
    } })

    add({ name: "horizon_list_skills", description: "List session-scoped skills.", inputSchema: hSchema(), execute: (args) => {
      const id = resolveId(args); const skills = this.horizon.listSkills(id); return skills.length ? `[horizon] Skills for ${id}:\n${skills.map((item) => `- ${item}`).join("\n")}` : `[horizon] No session-scoped skills for ${id}.`
    } })

    add({ name: "horizon_save_trace", description: "Archive a sub-agent JSON trace in the Horizon session.", inputSchema: hSchema({ subAgentSessionId: { type: "string" }, traceData: { description: "Trace object or JSON string." } }, ["subAgentSessionId", "traceData"]), execute: (args) => {
      const id = resolveId(args); const traceId = stringArg(args, "subAgentSessionId")!; const value = object(jsonArg(args, "traceData"), "traceData"); const path = this.horizon.saveTrace(id, traceId, value); return `[horizon] Trace archived for ${traceId}\nPath: ${path}`
    } })

    add({ name: "horizon_list_sessions", description: "List all Horizon sessions and metadata.", inputSchema: schema(), execute: () => {
      const sessions = this.horizon.listSessions(); return sessions.length ? `[horizon] Sessions (${sessions.length}):\n${sessions.map((item) => `${item.id} | ${item.meta.status} | ${item.meta.autonomyLevel} | ${item.meta.goal}`).join("\n")}` : "[horizon] No sessions found."
    } })

    add({ name: "horizon_session_status", description: "Get a complete Horizon status snapshot including artifacts.", inputSchema: hSchema(), execute: (args) => {
      const id = resolveId(args); const status = this.horizon.status(id); const plan = status.plan!; const state = status.state!
      return `[horizon] Session status: ${id}\nPlan: ${plan.status}\nPhase: ${state.currentPhase}\nProgress: ${plan.stats.completedFeatures}/${plan.stats.totalFeatures}\nDecisions: ${status.decisions.length}\nResearch: ${status.research.findings?.length ?? 0} chars\nSkills: ${status.skills.length}\nTraces: ${status.traces.length}\nRetries: ${plan.stats.totalRetries}${state.pausedAt ? `\nPAUSED: ${state.pauseReason ?? "unknown"}` : ""}`
    } })

    add({ name: "horizon_evaluate_subagent", description: "Score a sub-agent after the plugin independently runs the project's detected verification checks.", inputSchema: hSchema({ featureId: { type: "string" }, protocolIntegrity: { type: "number", minimum: 0, maximum: 100 }, correctness: { type: "number", minimum: 0, maximum: 100 }, designQuality: { type: "number", minimum: 0, maximum: 100 }, edgeCaseCoverage: { type: "number", minimum: 0, maximum: 100 }, userPerspective: { type: "number", minimum: 0, maximum: 100 } }, ["featureId", "protocolIntegrity", "correctness", "designQuality", "edgeCaseCoverage", "userPerspective"]), execute: async (args) => {
      const id = resolveId(args); const featureId = stringArg(args, "featureId")!
      const planBeforeVerification = this.horizon.readPlan(id)!
      const featureBeforeVerification = planBeforeVerification.milestones.flatMap((milestone) => milestone.features).find((feature) => feature.id === featureId)
      if (!featureBeforeVerification) throw new Error(`Feature '${featureId}' was not found`)
      const expectedFeatureDigest = featureVerificationDigest(planBeforeVerification.goal, featureBeforeVerification)
      const verification = await runVerification(detectProject(this.projectRoot), [], { thorough: true })
      const verificationDimension = verification.verdict === "pass" ? 100 : 0
      const verificationEvidence = truncate(`Command: ${verification.command ?? "none"}; verdict: ${verification.verdict}; exit: ${verification.exitCode ?? "none"}\n${verification.stderr || verification.stdout}`, 4_000)
      const dimensions = [["Protocol Integrity", numberArg(args, "protocolIntegrity"), .15], ["Verification", verificationDimension, .25], ["Correctness", numberArg(args, "correctness"), .25], ["Design Quality", numberArg(args, "designQuality"), .15], ["Edge Case Coverage", numberArg(args, "edgeCaseCoverage"), .10], ["User Perspective", numberArg(args, "userPerspective"), .10]] as const
      for (const [, value] of dimensions) if (value < 0 || value > 100) throw new Error("All evaluation scores must be between 0 and 100")
      const score = Math.round(dimensions.reduce((sum, [, value, weight]) => sum + value * weight, 0))
      const passed = score >= 75 && verification.verdict === "pass"
      const breakdown = dimensions.map(([label, value, weight]) => `${label}: ${value}/100 x ${weight * 100}%`).join("; ")
      const issues = passed ? [] : [verification.verdict !== "pass" ? `Independent verification ${verification.verdict}` : `Weighted score ${score}/100 is below 75`]
      const plan = this.horizon.recordEvaluation(id, featureId, { passed, testResults: verificationEvidence, issues, score }, expectedFeatureDigest); if (!plan) throw new Error(`Feature '${featureId}' was not found`)
      this.horizon.appendDecision(id, { timestamp: new Date().toISOString(), feature: featureId, ambiguity: `Self-check evaluation for ${featureId}`, researchResult: `Weighted score ${score}/100; ${verificationEvidence}`, decision: passed ? "PASS" : "FAIL", rationale: breakdown, confidence: passed ? "high" : "medium" })
      return `[horizon] Self-check for '${featureId}': ${passed ? "PASS" : "FAIL"}\nWeighted score: ${score}/100 (threshold: 75); independent verification: ${verification.verdict.toUpperCase()}\n${breakdown}`
    } })

    add({ name: "horizon_config", description: "Read or merge validated Horizon configuration.", inputSchema: schema({ configJson: { description: "Partial config object or JSON string." } }), execute: (args) => {
      const parsed = jsonArg(args, "configJson", false)
      if (parsed !== undefined) this.horizon.saveConfig({ ...this.horizon.loadConfig(), ...object(parsed, "configJson") } as HorizonConfig)
      return `[horizon] Current config:\n${JSON.stringify(this.horizon.loadConfig(), null, 2)}`
    } })
  }
}

async function runStdio(): Promise<void> {
  const server = new ParallaxMcpServer()
  let buffer = ""
  process.stdin.setEncoding("utf8")
  for await (const chunk of process.stdin) {
    buffer += chunk
    while (true) {
      const newline = buffer.indexOf("\n")
      if (newline < 0) break
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let response: Record<string, unknown> | null
      try { response = await server.handleRequest(JSON.parse(line) as unknown) }
      catch (error) {
        response = { jsonrpc: "2.0", id: null, error: { code: -32600, message: error instanceof Error ? error.message : String(error) } }
      }
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ""
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runStdio().catch((error: unknown) => {
    process.stderr.write(`[parallax-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
