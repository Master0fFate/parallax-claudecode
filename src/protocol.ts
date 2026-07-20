import type { ProtocolStep, SessionState } from "./types.js"
import { addPhase } from "./trace.js"

const PREREQUISITE: Partial<Record<ProtocolStep, ProtocolStep>> = {
  invariants: "ambiguity",
  gate: "invariants",
  design: "gate",
  commit: "gate",
  summary: "commit",
}

const PHASE: Record<ProtocolStep, Parameters<typeof addPhase>[1]> = {
  ambiguity: "ambiguity_check",
  invariants: "four_invariants",
  gate: "verification_gate",
  design: "design_check",
  commit: "commit_decision",
  summary: "summary",
}

export function beginProtocolEpoch(state: SessionState): boolean {
  if (state.trace.writes.length <= state.protocol.startedWriteCount) return false
  state.protocol.epoch += 1
  state.protocol.startedWriteCount = state.trace.writes.length
  for (const step of Object.keys(state.protocol.completed) as ProtocolStep[]) state.protocol.completed[step] = false
  state.protocol.evidence = {}
  return true
}

export function checkIn(state: SessionState, step: ProtocolStep, evidence: string): void {
  const prerequisite = PREREQUISITE[step]
  if (prerequisite && !state.protocol.completed[prerequisite]) throw new Error(`Complete ${prerequisite} before ${step}`)
  if (evidence.trim().length < 8) throw new Error(`${step} requires concrete evidence of at least 8 characters`)
  if (state.protocol.completed[step]) return
  state.protocol.completed[step] = true
  state.protocol.evidence[step] = evidence.trim()
  addPhase(state.trace, PHASE[step], { evidence: evidence.trim(), protocolEpoch: state.protocol.epoch })
}
