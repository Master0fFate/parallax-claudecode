# Troubleshooting

Start with `parallax-claudecode doctor` (human Markdown) or `parallax-claudecode doctor --json` (schema-versioned machine output). Diagnostics redact project/home locations and never print settings contents or credentials.

## Plugin or skills do not appear

Build first, validate both manifests, then restart Claude Code:

```bash
npm ci
npm run build
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
```

For checkout development, run `npm run dev -- --help` or launch `claude --plugin-dir <absolute-path>`. For marketplace installation, inspect `claude plugin list` and reinstall `parallax-claudecode@parallax-local`.

If doctor reports a stale cache, rerun `parallax-claudecode --scope user` to invoke native marketplace/plugin update, then restart Claude. To uninstall while retaining Claude plugin data, run `claude plugin uninstall parallax-claudecode@parallax-local --scope user --keep-data`. This does not remove project `.parallax/` or `~/.parallax/horizon/` data.

## MCP tools are unavailable

Confirm `dist/mcp.js` exists and Node 20+ is on `PATH`. The `.mcp.json` command intentionally uses `${CLAUDE_PLUGIN_ROOT}`; do not replace it with a checkout-specific absolute path. Run `npm run build` after changing source.

## Writes are denied

The denial message identifies the next missing checkpoint. Use `:check-in` with concrete repository evidence for ambiguity, invariants, and gate, in order. A denied write is expected fail-closed behavior. Do not disable the hook or edit state manually.

If retries are exhausted, run `parallax_verify` for the affected session. A failing manual recovery check grants exactly one mutation permit so Claude can repair the code; the next mutation consumes it and must be followed immediately by verification. Recovery attempts are bounded by `maxRecoveryAttempts`, and a passing check restores the normal retry budget. `:status` reports the current gate and retry state.

## Session is missing or ambiguous

Pass the current Claude session ID to MCP tools. Omission is accepted only if one persisted session matches the working directory. With several sessions, select from the returned IDs rather than deleting or borrowing state.

## Verification runs the wrong command

Detection starts at the hook `cwd` and searches upward. Inspect the nearest Cargo, Go, Node, Python, or .NET manifest. For Node, Parallax respects lockfiles and prefers `check`, then available `typecheck`, `test`, `lint`, and `build` scripts. Add an explicit project `check` script when repository policy needs a different aggregate.

## Horizon artifact is rejected

Read the validation error and fix the producer. Typical causes are a foreign session ID, duplicate feature/plan IDs, invalid status enums, retries above the cap, or plan statistics inconsistent with feature status. Back up corrupt legacy data before initializing a replacement session.

## Corrupt ledger, queue, or stale lock

- Canonical receipts: `<project>/.parallax/verification-ledger.jsonl`; recovery copies corrupt bytes and a SHA-256 manifest to `<project>/.parallax/ledger-archive/`. Archives are evidence, never canonical receipts. Resume only after doctor reports the canonical ledger valid.
- Mutation queues: `<project>/.parallax/mutation-intents/<safe-session-id>/queue.json`. Preserve unresolved intent evidence; do not clear it merely to bypass verification.
- Locks are `*.lock` directories beside their stores. Remove one only after confirming its owner process is dead and no Claude/Parallax operation is active; rerun doctor afterward. Live locks resolve through bounded waiting and stale-owner recovery.
- Horizon recovery lives under `~/.parallax/horizon/sessions/<id>/`. Use the reported active-child identity and recovery tool; never substitute a different child ID.

Claude Code 2.1.215 has incomplete background subagent completion metadata. Use the foreground Horizon lifecycle; lack of background progress is not a stuck daemon because Horizon is not a daemon.

## Windows notes

Hooks and MCP launch Node directly, without POSIX shell syntax. Package-manager verification uses the required `cmd.exe` shim. If `claude` is not discoverable by the local installer, add the Claude Code executable to `PATH` and rerun it.
