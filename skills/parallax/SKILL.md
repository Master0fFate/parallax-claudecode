---
name: parallax
description: Compatibility entry point for the Parallax workflow when Claude resolves it as a plugin skill.
argument-hint: "[implementation, refactor, or debugging goal]"
user-invocable: true
---

# Parallax compatibility entry point

This skill name is intentionally available alongside the `parallax` Claude subagent. If the task is delegated, use the plugin-scoped `parallax-claudecode:parallax` **Agent** type; do not try to load this skill again. When running in the current session, apply the Parallax workflow directly:

1. Inspect the repository and classify ambiguity.
2. Establish state ownership, feedback, blast radius, and timing invariants.
3. Check the verification gate before mutation.
4. Use the Parallax MCP tools for analysis, ordered check-ins, build/debug mode, and verification.
5. Report observed checks and residual risk without claiming unrun work passed.

This compatibility entry point prevents older callers that incorrectly resolve the agent name through `Skill(...)` from failing during skill resolution.
