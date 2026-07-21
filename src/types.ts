export const PARALLAX_SCHEMA_VERSION = "1.0" as const

export type AgentMode = "free" | "plan" | "build" | "debug" | "horizon"
export type ProtocolStep = "ambiguity" | "invariants" | "gate" | "design" | "commit" | "summary"
export type ProjectType = "cargo" | "go" | "node" | "python" | "dotnet" | null
export type VerificationVerdict = "pass" | "fail" | "skipped" | "unknown"
export type VerificationSource = "manual" | "automatic"
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
  readonly schemaVersion: 2
  readonly id: string
  readonly sessionId: string
  readonly source: VerificationSource
  readonly startedAt: string
  readonly command: string | null
  readonly args: readonly string[]
  readonly cwd: string
  readonly timeoutMs: number
  readonly durationMs: number
  readonly exitCode: number | null
  readonly verdict: VerificationVerdict
  readonly changedFiles: readonly string[]
  readonly stdout: string
  readonly stderr: string
  readonly combined: string
  readonly outputTruncated: boolean
  readonly timedOut: boolean
  readonly skipReason: string | null
  /** @deprecated Use startedAt. Non-enumerable and absent from the schema-v2 wire form. */
  readonly timestamp: string
  /** @deprecated Use changedFiles. Non-enumerable and absent from the schema-v2 wire form. */
  readonly files: readonly string[]
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
export type HorizonAuditVerdict = "accept" | "corrective-worker"
export type HorizonChildRole = "worker" | "auditor"

export interface HorizonReceiptEvidence {
  id: string
  verdict: VerificationVerdict
  sessionId: string
  source: VerificationSource
  cwd: string
  startedAt: string
  observedAt: string
}

export interface HorizonWorkerEvidence {
  childRunId: string | null
  startedAt: string | null
  completedAt: string | null
  receipt: HorizonReceiptEvidence | null
  summary: string | null
  traceId: string | null
}

export interface HorizonAuditorEvidence {
  childRunId: string | null
  startedAt: string | null
  completedAt: string | null
  verdict: HorizonAuditVerdict | null
  summary: string | null
  traceId: string | null
}

export interface HorizonAttemptEvidence {
  worker: HorizonWorkerEvidence
  auditor: HorizonAuditorEvidence
}

export interface HorizonFeatureEvidence {
  worker: HorizonWorkerEvidence
  auditor: HorizonAuditorEvidence
  /** Completed prior attempts, retained when corrective work starts. */
  history: HorizonAttemptEvidence[]
}

export interface HorizonActiveChildLock {
  schemaVersion: 1
  root: string
  sessionId: string
  featureId: string
  role: HorizonChildRole
  childRunId: string
  acquiredAt: string
  leaseUntil: string
}

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
    /** Advisory compatibility only. Never authorizes completion. */
    passed: boolean
    testResults: string | null
    issues: string[]
    score: number | null
    /** SHA-256 binding verification to the plan goal and immutable feature definition. */
    featureDigest: string | null
  }
  evidence: HorizonFeatureEvidence
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
  source?: string
  tool_use_id?: string
  agent_id?: string
  agent_type?: string
  agent_transcript_path?: string
  last_assistant_message?: string
  error?: unknown
  [key: string]: unknown
}
