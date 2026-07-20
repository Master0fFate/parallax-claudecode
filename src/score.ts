import type { ParallaxTrace, PhaseName, ScoreBreakdown } from "./types.js"

const REQUIRED_PHASES: PhaseName[] = [
  "ambiguity_check",
  "four_invariants",
  "verification_gate",
  "commit_decision",
  "summary",
]

export function computeCoherenceScore(trace: ParallaxTrace): ScoreBreakdown {
  const phases = new Set(trace.phases.map((record) => record.phase))
  const protocolCoverage = Math.round(REQUIRED_PHASES.filter((phase) => phases.has(phase)).length / REQUIRED_PHASES.length * 30)

  const known = trace.verifications.filter((record) => record.verdict !== "skipped")
  const verificationIntegrity = known.length
    ? Math.round(known.filter((record) => record.verdict === "pass").length / known.length * 35)
    : 0

  const edgeTopics = new Set(trace.phases.flatMap((record) => {
    const topic = record.data.analysisTopic
    return typeof topic === "string" && topic.trim() ? [topic.trim().toLowerCase()] : []
  }))
  const edgeCaseCoverage = Math.min(20, Math.round(edgeTopics.size / 7 * 20))

  let cursor = -1
  let ordered = 0
  for (const required of REQUIRED_PHASES) {
    const next = trace.phases.findIndex((record, index) => index > cursor && record.phase === required)
    if (next < 0) break
    cursor = next
    ordered += 1
  }
  const timingDiscipline = Math.round(ordered / REQUIRED_PHASES.length * 15)
  const total = Math.min(100, protocolCoverage + verificationIntegrity + edgeCaseCoverage + timingDiscipline)
  return { total, protocolCoverage, verificationIntegrity, edgeCaseCoverage, timingDiscipline }
}

export function scoreToGrade(score: number): "S" | "A" | "B" | "C" | "D" | "F" {
  if (score >= 90) return "S"
  if (score >= 80) return "A"
  if (score >= 70) return "B"
  if (score >= 60) return "C"
  if (score >= 40) return "D"
  return "F"
}

export function formatScoreBreakdown(score: ScoreBreakdown): string {
  return [
    `Coherence Score: ${score.total}/100 (${scoreToGrade(score.total)})`,
    `Protocol Coverage: ${score.protocolCoverage}/30`,
    `Verification Integrity: ${score.verificationIntegrity}/35`,
    `Edge Case Coverage: ${score.edgeCaseCoverage}/20`,
    `Timing Discipline: ${score.timingDiscipline}/15`,
  ].join("\n")
}
