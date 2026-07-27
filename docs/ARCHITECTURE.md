# Architecture

Parallax is a native Claude Code plugin: Claude discovers its agents, skills, hooks, and MCP server directly from the repository layout. There is no OpenCode compatibility shim.

## Runtime map

```text
Claude Code session
  -> hooks/hooks.json -> dist/hook.js
       -> .parallax/sessions/<safe-session-id>/state.json
       -> project-aware verification
       -> .parallax/traces/<safe-session-id>.json
       -> .parallax/mutation-intents/<safe-session-id>/queue.json
       -> .parallax/verification-ledger.jsonl
       -> .parallax/ledger-archive/
  -> .mcp.json -> dist/mcp.js
       -> Parallax protocol/mode/trace tools
       -> HorizonStore -> ~/.parallax/horizon
  -> agents/{parallax,horizon,horizon-worker,horizon-auditor}.md
  -> skills/*/SKILL.md (invoked as /parallax-claudecode:<skill>, including the parallax compatibility entry point)
```

## Trust and state boundaries

The Claude `session_id` is the isolation key. Hook input supplies it; every session-bound MCP call accepts it. Unsafe IDs are mapped to deterministic filesystem-safe names, while persisted schemas retain and validate the original ID. Ambiguous implicit MCP lookup fails rather than choosing a session.

`SessionStore` owns project-local protocol state and traces. `HorizonStore` owns durable plans, decisions, research, generated skills, evaluations, and archived traces. Both stores validate at the persistence boundary and use contained paths. Every SessionStore and HorizonStore mutation uses multiprocess locks and atomic replacement; trace finalization and export share the session transaction.

`MutationIntentQueue` correlates native pre/post mutation evidence. `VerificationLedger` is the canonical append-only schema-v2 receipt source; corrupt bytes are recovered only into hash-manifested, explicitly non-canonical `.parallax/ledger-archive/` artifacts. Horizon storage defaults to `~/.parallax/horizon/sessions/`; `PARALLAX_HORIZON_HOME` relocates it.

## Hook lifecycle

`SessionStart` initializes context. `UserPromptSubmit` starts a new task-scope protocol epoch after prior mutations. `PreToolUse` gates every mutation-capable surface, including Bash. Native `PostToolBatch` correlates structured tool-use IDs and statuses, excludes denied/failed calls, and groups successful writes into one verification run. `PostToolUseFailure` records failed mutation attempts. Subagent and compaction hooks preserve concise recovery context. `Stop` exports a non-final checkpoint; only `SessionEnd` sets `endedAt` and finalizes the trace.

The gate is fail-closed: ambiguity, four-invariant, and verification-gate evidence must be persisted before mutation. Verification failure consumes bounded retries; exhausted friction blocks further writes until explicit recovery.

Horizon enforces one correlated child lease and separates worker mutation from read-only audit. Claude Code 2.1.215 does not provide complete background subagent completion metadata, so foreground dispatch plus both Stop and Agent completion evidence is required. Horizon is durable supervision while Claude is running, not a daemon or a perfection guarantee.

## Packaging

TypeScript compiles to `dist/`. Plugin metadata references runtime files through `${CLAUDE_PLUGIN_ROOT}`, making source checkout, marketplace cache, and packed npm layouts relocatable. `npm run verify:package` checks that every declared runtime and user-facing asset is included by `npm pack`.

`doctor.ts` is the shared diagnostic core for CLI, MCP, and status. Its schema-versioned JSON uses `<project>` and `~` path labels and does not emit settings contents, credentials, or full installation paths.

The plugin exposes both a `parallax` subagent and a `parallax` skill compatibility entry point. Claude should delegate implementation work through the plugin-scoped Agent type; the skill alias exists so callers that resolve the name through `Skill(...)` do not fail with an unknown-skill error.
