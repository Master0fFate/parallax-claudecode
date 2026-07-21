---
name: status
description: Report the current Claude session's Parallax gate, retries, verification, and trace status.
user-invocable: true
allowed-tools: mcp__plugin_parallax-claudecode_parallax__parallax_health, mcp__plugin_parallax-claudecode_parallax__parallax_doctor, mcp__plugin_parallax-claudecode_parallax__parallax_trace_view
---

# Status

Call `parallax_health` with the current Claude session ID and `parallax_doctor` with `format: "markdown"`. Do not inspect or borrow another session.

Report, in this order:

1. active mode and completed/next protocol checkpoint;
2. write-gate state and verification retries remaining;
3. latest verification command, result, and discovered project root;
4. changed files and trace/coherence evidence;
5. a single actionable recovery step when blocked.
6. package/native registration, entrypoint, configuration, storage, lock, queue, and role-permission doctor findings.

Keep the response compact. Distinguish persisted facts from unavailable data. If session selection is ambiguous, list the tool's candidate IDs and explain that an explicit ID is required; never guess.
