---
name: horizon
description: Run a durable Horizon workflow for a multi-feature goal with bounded autonomous retries and an audit trail.
argument-hint: "[long-horizon goal]"
user-invocable: true
---

# Horizon

Switch the current core session with `parallax_horizon`. For `$ARGUMENTS`, resume only an explicitly matching Horizon session or initialize a unique ID with `horizon_init_session`.

Research first and persist concise findings. Write a schema-valid milestone and feature plan with measurable acceptance criteria. Use full Parallax protocol for implementation, refactors, architecture, security, and complex fixes; use `none` only for bounded research or trivial changes.

Execute one feature at a time. Keep plan and orchestration state synchronized and log consequential autonomous decisions. Evaluate each result with `horizon_evaluate_subagent`; it independently runs detected project checks and derives the verification dimension rather than trusting caller prose. Passing checks and an aggregate score of at least 75 are required; otherwise run a corrective pass. Never exceed the configured retry cap. Pause mid-run only for an external resource or authorization that cannot be researched or safely defaulted.

When dispatching `parallax-claudecode:horizon-worker` or `parallax-claudecode:horizon-auditor`, the first prompt line must be exactly `HORIZON_DISPATCH {"sessionId":"<horizon-session>","featureId":"<feature>"}` followed by the brief. A human brief alone is rejected because it has no durable session/feature identity.

Complete with a final debug audit, broad verification, archived traces where useful, consistent completion stats, and an honest report of completed, failed, and deferred work.
