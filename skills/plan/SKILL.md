---
name: plan
description: Create an execution-ready Parallax plan grounded in repository evidence and explicit verification.
argument-hint: "[goal]"
user-invocable: true
---

# Plan

Pass the current Claude session ID to `parallax_plan`, then plan `$ARGUMENTS` without modifying files.

1. Read project instructions, manifests, architecture, tests, and the nearest comparable implementation.
2. Resolve material ambiguity. State the four invariants with concrete owners and paths.
3. Analyze nominal behavior, boundaries, errors, security, concurrency, compatibility, rollback, and observability.
4. For cross-subsystem or high-risk work, run the Hyperplan skill and incorporate only critiques supported by evidence.
5. Produce ordered, atomic items. Each item must name its files or component, observable acceptance criterion, and targeted check.
6. Identify assumptions, external blockers, and deferred work explicitly.

A good plan is short enough to execute, detailed enough for another agent to verify, and does not claim certainty unsupported by repository evidence.
