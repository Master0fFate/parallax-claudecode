import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ParallaxConfig, SessionState } from "./types.js"

export const DEFAULT_PARALLAX_CONFIG: Readonly<ParallaxConfig> = Object.freeze({
  // The OpenCode implementation's effective default is strict (its README once said
  // standard). Keep the runtime behavior and this port's pre-config safety invariant.
  strictness: "strict",
  designDocRequired: false,
  maxRetries: 3,
  maxRecoveryAttempts: 3,
})

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return value
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${label} must be a string array`)
  return [...value]
}

/**
 * Load and validate source-compatible project policy. Arbitrary verification commands are
 * deliberately rejected: repository configuration may select gates and budgets, but may not
 * introduce a new executable that hooks run automatically. Verification remains project-type
 * and package-script based in detect.ts.
 */
export function loadParallaxConfig(projectRoot: string): ParallaxConfig {
  const path = join(resolve(projectRoot), ".parallax", "config.json")
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_PARALLAX_CONFIG }
    throw new Error(`Invalid Parallax config at ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!object(raw)) throw new Error(`Invalid Parallax config at ${path}: expected a JSON object`)

  for (const key of ["verificationCommand", "verificationCommands", "verifyCommand", "command"] as const) {
    if (raw[key] !== undefined) throw new Error(`Invalid Parallax config at ${path}: '${key}' is not supported; verification commands cannot be supplied by project config`)
  }

  const strictness = raw.strictness ?? DEFAULT_PARALLAX_CONFIG.strictness
  if (!(["strict", "standard", "relaxed"] as unknown[]).includes(strictness)) throw new Error(`Invalid Parallax config at ${path}: strictness must be strict, standard, or relaxed`)
  const designDocRequired = raw.designDocRequired ?? DEFAULT_PARALLAX_CONFIG.designDocRequired
  if (typeof designDocRequired !== "boolean") throw new Error(`Invalid Parallax config at ${path}: designDocRequired must be boolean`)

  const config: ParallaxConfig = {
    strictness: strictness as ParallaxConfig["strictness"],
    designDocRequired,
    maxRetries: raw.maxRetries === undefined ? DEFAULT_PARALLAX_CONFIG.maxRetries : boundedInteger(raw.maxRetries, "config.maxRetries", 1, 20),
    maxRecoveryAttempts: raw.maxRecoveryAttempts === undefined ? DEFAULT_PARALLAX_CONFIG.maxRecoveryAttempts : boundedInteger(raw.maxRecoveryAttempts, "config.maxRecoveryAttempts", 1, 10),
  }
  // Preserve and validate OpenCode-era policy metadata so an existing config is accepted
  // without claiming that these fields alter Claude's native gate behavior.
  if (raw.minScore !== undefined) {
    if (typeof raw.minScore !== "number" || !Number.isFinite(raw.minScore) || raw.minScore < 0 || raw.minScore > 100) throw new Error("config.minScore must be a finite number from 0 to 100")
    config.minScore = raw.minScore
  }
  if (raw.adaptiveProtocol !== undefined) {
    if (typeof raw.adaptiveProtocol !== "boolean") throw new Error("config.adaptiveProtocol must be boolean")
    config.adaptiveProtocol = raw.adaptiveProtocol
  }
  if (raw.trivialPatterns !== undefined) config.trivialPatterns = stringArray(raw.trivialPatterns, "config.trivialPatterns")
  if (raw.highRiskPatterns !== undefined) config.highRiskPatterns = stringArray(raw.highRiskPatterns, "config.highRiskPatterns")
  return config
}

/** Apply retry policy without erasing observed failures or granting already-consumed retries. */
export function applyParallaxConfig(state: SessionState, config: ParallaxConfig): SessionState {
  if (state.friction.maxRetries !== config.maxRetries && state.trace.metrics !== null) {
    state.trace.metrics = null
    state.trace.coherenceScore = null
  }
  const consumed = Math.max(state.friction.consecutiveFailures, state.friction.maxRetries - state.friction.retriesLeft)
  state.friction.consecutiveFailures = consumed
  state.friction.maxRetries = config.maxRetries
  state.friction.retriesLeft = Math.max(0, config.maxRetries - consumed)
  state.friction.recoveryAttempts = Math.min(state.friction.recoveryAttempts, config.maxRecoveryAttempts)
  return state
}
