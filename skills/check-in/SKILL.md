---
name: check-in
description: Record a Parallax protocol checkpoint with concrete evidence before gated implementation work.
argument-hint: "[ambiguity|invariants|gate|design|commit|summary] [evidence]"
user-invocable: true
---

# Check in

Use the current Claude session ID. Inspect the repository or tool results before recording evidence; never check in intent alone.

Call `parallax_checkin` with `$ARGUMENTS`. Respect protocol order:

1. `ambiguity` — classification, resolved questions, and bounded assumptions.
2. `invariants` — concrete state owner, feedback path, deletion coupling, and timing constraints.
3. `gate` — existing pattern, blast radius, security boundary, and exact verification command.
4. `design` — optional design evidence when risk or project policy requires it.
5. `commit` — Full Coherence, Pragmatic Partial, Hold + Clarify, or User Override with rationale.
6. `summary` — files, observable result, checks, and residual risk.

If the requested step is premature or evidence is missing, investigate or report the gap instead of calling the tool. On success, state only the recorded step and any next required step.
