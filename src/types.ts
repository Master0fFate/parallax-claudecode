export const PARALLAX_SCHEMA_VERSION = "1.0" as const

export type AgentMode = "free" | "plan" | "build" | "debug" | "horizon"
export type ProtocolStep = "ambiguity" | "invariants" | "gate" | "design" | "commit" | "summary"
export type ProjectType = "cargo" | "go" | "node" | "python" | "dotnet" | null
export type VerificationVerdict = "pass" | "fail" | "skipped"
export type ParallaxStrictness = "strict" | "standard" | "relaxed"

/** Validated project policy loaded from <project>/.parallax/config.json. */
export interface ParallaxConfig {
  strictness: ParallaxStrictness
  designDocRequired: boolean
  /** Consecutive verification failures permitted before writes block. */
  maxRetries: number
  /** Manual parallax_verify attempts permitted after the normal budget is exhausted. */
  maxRecoveryAttempts: number
  /** OpenCode-compatible metadata; currently consumed by external score policy only. */
  minScore?: number
  adaptiveProtocol?: boolean
  trivialPatterns?: string[]
  highRiskPatterns?: string[]
}

export type PhaseName =
  | "ambiguity_check"
  | "four_invariants"
  | "verification_gate"
  | "design_check"
  | "mode_switch"
  | "execution"
  | "commit_decision"
  | "summary"

export interface ProjectDetection {
  type: ProjectType
  root: string
  markers: string[]
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | null
}

export interface VerifyCommand {
  command: string
  args: string[]
  label: string
}

export interface VerificationRecord {
  id: string
  timestamp: string
  command: string | null
  files: string[]
  verdict: VerificationVerdict
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
}

export interface PhaseRecord {
  phase: PhaseName
  timestamp: string
  data: Record<string, unknown>
}

/** One record per changed file. All files in one tool call share batchId. */
export interface WriteRecord {
  batchId: string
  file: string
  tool: string
  timestamp: string
  verificationId: string | null
  verification: VerificationVerdict | "unknown"
  frictionRetriesLeft: number
}

export interface ParallaxTrace {
  schemaVersion: typeof PARALLAX_SCHEMA_VERSION
  session: {
    id: string
    agent: "parallax"
    agentVersion: string
    startedAt: string
    endedAt: string | null
    project: string
    projectType: ProjectType
  }
  phases: PhaseRecord[]
  writes: WriteRecord[]
  verifications: VerificationRecord[]
  metrics: TraceMetrics | null
  coherenceScore: number | null
}

export interface TraceMetrics {
  maxRetries: number
  computedAt: string
  durationSeconds: number
  totalPhases: number
  totalWrites: number
  verificationPassRate: number
  firstAttemptPassRate: number
  totalFrictionRetries: number
  protocolStepsCompleted: number
}

export interface ScoreBreakdown {
  total: number
  protocolCoverage: number
  verificationIntegrity: number
  edgeCaseCoverage: number
  timingDiscipline: number
}

export interface ProtocolState {
  /** Task-scope epoch. A new prompt after mutations starts a fresh gate. */
  epoch: number
  startedWriteCount: number
  completed: Record<ProtocolStep, boolean>
  evidence: Partial<Record<ProtocolStep, string>>
}

export interface SessionState {
  schemaVersion: typeof PARALLAX_SCHEMA_VERSION
  sessionId: string
  cwd: string
  mode: AgentMode
  protocol: ProtocolState
  friction: {
    successes: number
    trials: number
    consecutiveFailures: number
    maxRetries: number
    retriesLeft: number
    /** Manual recovery verifications attempted while the normal retry budget is exhausted. */
    recoveryAttempts: number
    /** One-shot mutation permits granted by a failed manual recovery verification. */
    repairWritesRemaining: number
    lastObservation: string | null
  }
  trace: ParallaxTrace
  updatedAt: string
}

export type HorizonAutonomyLevel = "full" | "semi" | "supervised"
export type HorizonPhase = "research" | "plan" | "execute" | "audit" | "complete"
export type HorizonPlanStatus = "planning" | "executing" | "completed" | "failed"
export type HorizonItemStatus = "pending" | "in_progress" | "completed" | "failed"
export type HorizonProtocolLevel = "none" | "full"

export interface HorizonFeature {
  id: string
  name: string
  description: string
  acceptanceCriteria: string
  protocolLevel: HorizonProtocolLevel
  status: HorizonItemStatus
  order: number
  subAgentSessionId: string | null
  attempts: number
  maxAttempts: number
  verification: {
    passed: boolean
    testResults: string | null
    issues: string[]
    score: number | null
    /** SHA-256 binding verification to the plan goal and immutable feature definition. */
    featureDigest: string | null
  }
  skillsRequired: string[]
  skillsGenerated: string[]
}

export interface HorizonMilestone {
  id: string
  name: string
  description: string
  status: HorizonItemStatus
  order: number
  requiresApproval: boolean
  features: HorizonFeature[]
}

export interface HorizonPlan {
  schemaVersion: typeof PARALLAX_SCHEMA_VERSION
  sessionId: string
  goal: string
  autonomyLevel: HorizonAutonomyLevel
  status: HorizonPlanStatus
  createdAt: string
  completedAt: string | null
  milestones: HorizonMilestone[]
  skills: { global: string[]; sessionScoped: string[] }
  stats: {
    totalFeatures: number
    completedFeatures: number
    failedFeatures: number
    totalRetries: number
    estimatedCost: number | null
  }
}

export interface HorizonState {
  schemaVersion: typeof PARALLAX_SCHEMA_VERSION
  sessionId: string
  currentPhase: HorizonPhase
  activeSubAgents: string[]
  currentMilestoneId: string | null
  currentFeatureId: string | null
  lastCheckpoint: string
  pausedAt: string | null
  pauseReason: string | null
}

export interface HorizonDecision {
  timestamp: string
  feature: string
  ambiguity: string
  researchResult: string
  decision: string
  rationale: string
  confidence: "high" | "medium" | "low"
}

export interface HorizonConfig {
  autonomyLevel: HorizonAutonomyLevel
  autoApproveMilestones: boolean
  maxRetryCycles: number
  decisionConfidenceThreshold: number
  pauseOnCriticalFailure: boolean
  testCommand: string
  lintCommand: string
}

export interface HorizonSessionMeta {
  goal: string
  createdAt: string
  updatedAt: string
  status: HorizonPlanStatus
  autonomyLevel: HorizonAutonomyLevel
}

export interface HorizonIndex {
  schemaVersion: typeof PARALLAX_SCHEMA_VERSION
  sessions: Record<string, HorizonSessionMeta>
}

export interface HyperplanAngle {
  id: string
  name: string
  attackVector: string
  instruction: string
  focusAreas: string[]
  severity: "critical" | "major" | "minor"
}

export interface HyperplanCritique {
  angleId: string
  angleName: string
  findings: string
  severity: "critical" | "major" | "minor"
  affectedAreas: string[]
}

export interface HyperplanResult {
  complexity: "trivial" | "moderate" | "complex"
  reason: string
  skipped: boolean
  angles: HyperplanAngle[]
  prompts: Array<{ angleId: string; prompt: string }>
}

export interface HyperplanSynthesis {
  confidence: number
  survivingInsights: string[]
  rejectedCritiques: Array<{ critique: string; reason: string }>
  hardenedPlan: string
  summary: string
}

export interface ClaudeHookToolCall {
  tool_name?: string
  tool_input?: unknown
  tool_use_id?: string
  tool_response?: unknown
  status?: string
  is_error?: boolean
  [key: string]: unknown
}

export interface ClaudeHookToolResult {
  tool_use_id?: string
  toolUseId?: string
  id?: string
  status?: string
  is_error?: boolean
  denied?: boolean
  [key: string]: unknown
}

export interface ClaudeHookInput {
  session_id?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: unknown
  tool_response?: unknown
  tool_calls?: ClaudeHookToolCall[]
  tool_results?: ClaudeHookToolResult[]
  [key: string]: unknown
}
