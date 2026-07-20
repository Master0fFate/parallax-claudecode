---
name: trace
description: Inspect or export the current session's Parallax reasoning and verification trace.
argument-hint: "[view|export]"
user-invocable: true
allowed-tools: mcp__plugin_parallax-claudecode_parallax__parallax_trace_view, mcp__plugin_parallax-claudecode_parallax__parallax_trace_export
---

# Trace

Use only the current Claude session ID; never infer or reuse another session. For `$ARGUMENTS`:

- `view` (default): call `parallax_trace_view` and summarize protocol phases, write batches, verification evidence, and coherence findings.
- `export`: call `parallax_trace_export`, then report the exact artifact path and score.

A trace is an audit record, not hidden chain-of-thought. Report concise decisions, observations, tool outcomes, and evidence. Do not invent missing phases or represent an unrun check as passing. If the session is ambiguous or absent, return the tool's recovery guidance.
