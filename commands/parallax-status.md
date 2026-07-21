---
description: Summarize the current session and run package/native lifecycle diagnostics.
allowed-tools: Read, Glob, Bash
---

Run `parallax-claudecode doctor`, then read only the state for this Claude session under `.parallax/sessions/`. Do not use another session's state. Summarize protocol progress, latest verification, retries remaining, changed files, doctor findings, and current observed coherence evidence. If a session-safe state cannot be unambiguously identified, report that instead of guessing.
