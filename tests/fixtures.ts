import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HorizonFeature, HorizonPlan } from "../src/types.js"
import { PARALLAX_SCHEMA_VERSION } from "../src/types.js"

/** Per-test filesystem fixture with deterministic model timestamps and explicit cleanup. */
export class TestWorkspace {
  readonly root: string

  constructor(label = "workspace") {
    this.root = mkdtempSync(join(tmpdir(), `parallax-${label}-`))
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true })
  }
}

export const FIXED_TIME = "2026-01-02T03:04:05.000Z"

export function feature(overrides: Partial<HorizonFeature> = {}): HorizonFeature {
  return {
    id: "f1",
    name: "Feature one",
    description: "Deterministic fixture",
    acceptanceCriteria: "The fixture remains deterministic",
    protocolLevel: "full",
    status: "pending",
    order: 1,
    subAgentSessionId: null,
    attempts: 0,
    maxAttempts: 3,
    verification: { passed: false, testResults: null, issues: [], score: null, featureDigest: null },
    evidence: {
      worker: { childRunId: null, startedAt: null, completedAt: null, receipt: null, summary: null, traceId: null },
      auditor: { childRunId: null, startedAt: null, completedAt: null, verdict: null, summary: null, traceId: null },
      history: [],
    },
    skillsRequired: [],
    skillsGenerated: [],
    ...overrides,
  }
}

export function horizonPlan(sessionId = "fixture-session", featureOverrides: Partial<HorizonFeature> = {}): HorizonPlan {
  const item = feature(featureOverrides)
  return {
    schemaVersion: PARALLAX_SCHEMA_VERSION,
    sessionId,
    goal: "Exercise a deterministic Horizon plan",
    autonomyLevel: "full",
    status: "planning",
    createdAt: FIXED_TIME,
    completedAt: null,
    milestones: [{
      id: "m1",
      name: "Milestone one",
      description: "Deterministic fixture",
      status: "pending",
      order: 1,
      requiresApproval: false,
      features: [item],
    }],
    skills: { global: [], sessionScoped: [] },
    stats: {
      totalFeatures: 1,
      completedFeatures: item.status === "completed" ? 1 : 0,
      failedFeatures: item.status === "failed" ? 1 : 0,
      totalRetries: item.attempts,
      estimatedCost: null,
    },
  }
}
