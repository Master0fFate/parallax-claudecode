---
name: debug
description: Perform an evidence-based Parallax diagnosis or post-build audit and verify the repair.
argument-hint: "[failure, artifact, or audit vectors]"
user-invocable: true
---

# Debug

Pass the current Claude session ID to `parallax_debug`. Audit `$ARGUMENTS` with professional skepticism.

1. Establish the expected behavior and reproduce the symptom with the narrowest reliable command.
2. Separate direct evidence, strong inference, and unknowns. Trace state ownership, feedback, coupling, and timing before proposing a cause.
3. Rank findings by material impact and likelihood. Cite paths, tests, logs, or command output; ignore cosmetic noise unless requested.
4. Fix root causes rather than suppressing errors. Keep the patch surgical and add a regression check that fails before the fix when practical.
5. Run targeted verification, then broader checks proportional to blast radius.

Report diagnosis, root cause, changed files, test evidence, limitations, and remaining risk. If evidence is insufficient, say so rather than assigning a confident verdict.
