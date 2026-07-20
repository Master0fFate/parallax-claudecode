# Migration from parallax-opencode

The Claude Code port preserves the Parallax and Horizon concepts, but uses native Claude Code extension points. Do not copy an OpenCode configuration or standalone plugin file into Claude Code.

## Install the native plugin

```bash
cd parallax-claudecode
npm ci
npm run build
npm run install:local
```

Alternatively, add this repository as a marketplace and install `parallax-claudecode@parallax-local`. Restart Claude Code after installation.

## Command mapping

| OpenCode | Claude Code |
|---|---|
| Parallax/Horizon primary tabs | `parallax` or `horizon` subagent |
| copied `parallax-plan` skill | `/parallax-claudecode:plan` |
| copied `parallax-debug` skill | `/parallax-claudecode:debug` |
| plugin mode tool | `/parallax-claudecode:build`, `:plan`, `:debug`, or `:horizon` |
| trace tools | `/parallax-claudecode:trace` |
| health/status | `/parallax-claudecode:status` |
| OpenCode event hooks | native Claude lifecycle hooks |
| in-process custom tools | bundled stdio MCP server |

## State migration

OpenCode's project-level `.parallax/state.json` is not imported because it is not safely attributable to a Claude session. Start a Claude session to create `.parallax/sessions/<session-id>/state.json`. Existing source files and project configuration remain untouched.

Horizon data under `~/.parallax/horizon` is structurally validated by this port. On first access to an OpenCode-era index, the store copies the complete directory to a timestamped sibling `horizon-opencode-backup-*` **before** adding Claude schema metadata. Every plan, state, index entry, decision record, and indexed session directory is validated before commit. Any validation or write failure restores the original artifacts from the backup and does not write the migrated marker. Do not delete the backup until every migrated session passes `horizon_session_status`.

## Project configuration migration

The source-compatible project file remains `.parallax/config.json`; no copy is needed. Claude validates and applies `strictness`, `designDocRequired`, `maxRetries`, and `maxRecoveryAttempts`. OpenCode score/adaptive/path metadata is validated and retained as compatibility metadata but does not alter Claude's native hooks.

`standard` and `relaxed` both require ambiguity before a write and permit at most three persisted mutation batches before missing invariant evidence blocks further mutation, matching the source implementation's soft-invariant branch. Multi-file records in one batch consume one slot. `strict` requires ambiguity, invariants, and the verification gate before every mutation. When `designDocRequired` is enabled, Claude intentionally requires the full ordered chain through design in all modes; it does not preserve the OpenCode missing-invariants or `PARALLAX_FORCE` bypasses.

Do not put a shell command in project policy. Claude rejects `verificationCommand`, `verificationCommands`, `verifyCommand`, and `command`; automatic checks come only from project detection and known package scripts. Trusted API callers may still pass structured `{ command, args, label }` values directly to `runVerification`.

## Behavioral differences

- Every session-bound call should pass the current Claude `session_id`; implicit lookup works only for exactly one matching session.
- Verification happens once per native `PostToolBatch`, not once per individual edit call.
- Agents and skills are namespaced by Claude as `parallax-claudecode:*`.
- Installation has no package lifecycle side effects. The explicit installer invokes Claude's marketplace commands.
- Hidden reasoning is never persisted; traces contain decisions, observations, write records, and verification evidence only.
