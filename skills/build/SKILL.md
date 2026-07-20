---
name: build
description: Implement a planned change under the Parallax write gate with friction-loop verification.
argument-hint: "[plan item or implementation goal]"
user-invocable: true
---

# Build

Use the current Claude session ID and call `parallax_build`. Before the first mutation, ensure ambiguity, invariants, and gate check-ins contain concrete evidence.

Implement `$ARGUMENTS` in the smallest coherent batches. Follow project instructions and nearby patterns; preserve public behavior unless the plan changes it. Validate trust-boundary input and handle relevant empty, failure, ordering, and compatibility cases.

After each mutation batch, read the native verification result. On failure, diagnose and fix the cause. Use `parallax_verify` for an explicit or thorough check when needed. Never weaken checks, bypass a denied write, or mutate after retries are exhausted.

Finish by reviewing the diff, running targeted tests, recording the commit decision and summary, and reporting changed files, verified behavior, commands, and residual risk.
