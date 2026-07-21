# Parallax for Claude Code

<p align="center">
  <strong>Evidence-first engineering for Claude Code.</strong><br>
  Protocol gates, project-aware verification, auditable traces, hardened planning, and durable autonomous execution.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/parallax-claudecode"><img alt="npm version" src="https://img.shields.io/npm/v/parallax-claudecode?style=flat-square&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/parallax-claudecode"><img alt="npm downloads" src="https://img.shields.io/npm/dm/parallax-claudecode?style=flat-square&color=2f80ed"></a>
  <a href="https://github.com/Master0fFate/parallax-claudecode/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Master0fFate/parallax-claudecode/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white">
</p>

Parallax turns repository work into a visible, testable protocol. Before mutation, it captures ambiguity, invariants, and verification evidence. After mutation, it verifies the native tool batch, records a linked trace, and bounds retries instead of quietly weakening the gate. State is isolated by Claude `session_id`; Horizon plans are schema-validated and durable across long-running sessions.

## Why Parallax

| Capability | What it gives you |
|---|---|
| **Protocol gates** | Evidence-backed ambiguity, invariant, design, and verification checkpoints before writes |
| **Native verification** | Project detection for Node, Python, Go, Rust, and .NET without shell-interpolated commands |
| **Auditable traces** | Linked decisions, mutations, verification results, friction, and coherence metrics |
| **Hyperplan** | Adversarial plan review before high-risk architecture, migration, or security work |
| **Horizon** | Durable milestone execution with bounded retries and independently verified completion |
| **Claude-native integration** | 12 native lifecycle hook events, 37 MCP tools, 9 skills, and four focused agents |

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) `>=2.1.215 <3` (tested range)
- Node.js 20 or newer

## Installation

### npm — recommended

Install the package globally, then register the plugin with Claude Code:

```bash
npm install --global parallax-claudecode
parallax-claudecode --scope user
```

Restart Claude Code, open any project, and run:

```text
/parallax-claudecode:status
```

The installer is explicit by design: installing an npm package never edits Claude settings as a hidden lifecycle side effect. Available scopes:

```bash
parallax-claudecode --scope user      # all projects for your user
parallax-claudecode --scope project   # shared through .claude/settings.json
parallax-claudecode --scope local     # private to the current checkout
parallax-claudecode --dry-run         # preview Claude commands only
parallax-claudecode doctor --json     # stable machine-readable diagnostics
```

Doctor derives the current hook events and exact `parallax_*`/`horizon_*` MCP tool names from the installed runtime, so its inventory and count cannot drift from a packed release.

To update:

```bash
npm update --global parallax-claudecode
parallax-claudecode --scope user
```

Native uninstall is explicit; Parallax never edits Claude settings or deletes plugin data itself:

```bash
parallax-claudecode uninstall --scope user --keep-data
# equivalent native command:
claude plugin uninstall parallax-claudecode@parallax-local --scope user --keep-data
```

Omit `--keep-data` only when you intend Claude to remove its plugin data directory. Project `.parallax/` and `~/.parallax/horizon/` stores are separate and remain yours to archive or remove.

### From source

```bash
git clone https://github.com/Master0fFate/parallax-claudecode.git
cd parallax-claudecode
npm ci
npm run build
npm run install:local
```

For development without installation:

```bash
npm run dev
```

`npm run dev` launches `claude --plugin-dir <repository>` and forwards arguments after `--`.

### Manual marketplace installation

```bash
claude plugin marketplace add /absolute/path/to/parallax-claudecode
claude plugin install parallax-claudecode@parallax-local
```

Validate a checkout with:

```bash
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
npm run check
```

## Use

Claude namespaces plugin skills automatically:

| Invocation | Purpose |
|---|---|
| `/parallax-claudecode:check-in` | Persist an evidence-backed protocol checkpoint |
| `/parallax-claudecode:plan` | Produce a repository-grounded executable plan |
| `/parallax-claudecode:build` | Implement behind the write and friction gates |
| `/parallax-claudecode:debug` | Diagnose or audit with evidence and targeted repair |
| `/parallax-claudecode:horizon` | Run durable multi-feature supervision |
| `/parallax-claudecode:hyperplan` | Harden a risky plan through adversarial review |
| `/parallax-claudecode:trace` | View or export the current session trace |
| `/parallax-claudecode:status` | Show gate, retry, verification, and coherence state |

The plugin also supplies `parallax` and `horizon` subagents. Ask Claude to use **parallax** for non-trivial implementation/refactoring/debugging and **horizon** for a large goal requiring durable feature tracking and bounded autonomous retries.

Examples: [interactive check-in](examples/check-in.md), [long-horizon goal](examples/horizon-goal.md), and [Hyperplan](examples/hyperplan.md).

## Protocol

1. **Ambiguity:** classify LOW/MEDIUM/HIGH and resolve only material questions.
2. **Four invariants:** identify state ownership, feedback location, deletion coupling, and timing/ordering risk with concrete repository evidence.
3. **Verification gate:** establish the existing pattern, blast radius, trust boundary, and exact falsifying checks.
4. **Execute:** make coherent batches and repair failed verification without weakening checks.
5. **Commit decision:** choose Full Coherence, Pragmatic Partial, Hold + Clarify, or User Override.
6. **Summary:** report behavior, files, checks, and residual risk.

Hyperplan is optional for ordinary work and expected for meaningful integration, security, migration, architecture, or operational risk. It uses independent analysis, cross-attack, defense, and evidence-based synthesis rather than pasting critic prose into a plan.

## Horizon

Horizon persists plans and runs one worker at a time. Completion requires a worker-bound schema-v2 receipt with exact `pass`, followed by a distinct read-only auditor verdict; prose, legacy scores, and caller-supplied evidence do not open completion. Retries are bounded. Horizon advances only while Claude Code is running and permissions are granted: it is not a background daemon and does not guarantee autonomous or perfect completion. In Claude Code 2.1.215, background subagent completion metadata is incomplete, so Horizon conservatively uses foreground child dispatch and durable stop/completion correlation.

## Guarantee matrix

| Class | Exact guarantee |
|---|---|
| **Runtime-enforced** | Session/schema validation, ordered gate state, durable mutation intents, receipt ledger append/read-back, bounded retries, one active Horizon child, and worker/auditor identity transitions. |
| **Permission-enforced** | Worker cannot delegate or record audits; auditor has no Bash/Edit/Write/verify tools. Effective enforcement remains Claude Code's native tool permission system. |
| **Prompt-guided** | Investigation quality, scope discipline, summaries, and the instruction to avoid self-audit. Prompts are guidance, not a sandbox. |
| **Observed-only** | Test output, coherence metrics, liveness, and tool completion are evidence about observed runs—not proof of correctness, perfection, or future completion. |

## State and privacy

```text
<project>/.parallax/sessions/<safe-session-id>/state.json
<project>/.parallax/traces/<safe-session-id>.json
<project>/.parallax/mutation-intents/<safe-session-id>/queue.json
<project>/.parallax/verification-ledger.jsonl
<project>/.parallax/ledger-archive/*
~/.parallax/horizon/sessions/<horizon-id>/...
```

Session IDs are checked at persistence boundaries; unsafe IDs receive deterministic safe paths. Writes use locks and atomic replacement. Implicit MCP session lookup succeeds only when exactly one matching session exists. Traces contain concise decisions, observations, mutations, and verification evidence—not hidden chain-of-thought.

Set `PARALLAX_HORIZON_HOME` to relocate durable Horizon storage. The MCP server resolves project state from explicit API options first, then Claude's `CLAUDE_PROJECT_DIR`, then `PARALLAX_PROJECT_ROOT`, avoiding dependence on the plugin-cache working directory.

## Project policy

Parallax reads `<project>/.parallax/config.json` on each relevant hook or verification call. The effective default remains the OpenCode runtime default, `strict`. Existing OpenCode metadata is accepted and validated:

```json
{
  "strictness": "standard",
  "designDocRequired": false,
  "maxRetries": 3,
  "maxRecoveryAttempts": 3,
  "minScore": 70,
  "adaptiveProtocol": true,
  "trivialPatterns": ["*.md"],
  "highRiskPatterns": ["**/auth/**"]
}
```

- `strict` blocks mutation until ambiguity, invariants, and gate evidence is complete.
- `standard` and `relaxed` match the source implementation's soft behavior: ambiguity remains mandatory, then up to three persisted mutation batches are allowed before missing invariants blocks further mutation. A multi-file batch counts once; the source currently makes no enforcement distinction between these two values.
- `designDocRequired: true` always requires the ordered ambiguity → invariants → gate → design chain. This is an intentional fail-closed improvement over the legacy edge case where missing invariant evidence could bypass design enforcement. Claude Code does not honor `PARALLAX_FORCE` for this project policy.
- `maxRetries` is bounded to 1–20 and `maxRecoveryAttempts` to 1–10. Policy changes preserve observed failures rather than resetting them.
- `minScore`, `adaptiveProtocol`, and path patterns are compatibility metadata; they are validated but do not change native Claude hook policy in this release.

Malformed recognized fields fail the mutation gate closed. Project config cannot specify arbitrary verification executables (`verificationCommand` and related keys are rejected), because hooks run verification automatically.

## Verification detection

Detection begins at the hook working directory and searches parents. Cargo, Go, Node, Python, and .NET projects are supported. Node verification respects the project lockfile and prefers `check`, then available `typecheck`, `test`, `lint`, and `build` scripts. Commands use argument arrays rather than shell interpolation, including the required Windows package-manager shim. Explicit command arrays are available only to trusted programmatic callers of `runVerification`; repository config cannot add a command.

## Package and development

```bash
npm run typecheck
npm test
npm run coverage
npm run build
npm run verify:package
npm run check
npm run release:proof
npm pack --dry-run
```

Published packages include compiled `dist`, native plugin metadata, agents, all namespaced skills, hooks, docs, examples, license, and explicit install/dev/release-proof scripts. Source, tests, coverage, `.parallax/release-proof` reports, local state, and secrets are rejected by package verification. `npm run release:proof` performs a clean check, a bounded all-scope `npm audit` at the explicit `high` threshold, strict manifest validation, real tarball inspection, and isolated packed-runtime smoke against exactly Claude Code 2.1.215. Its sanitized schema-v2 report is written under `.parallax/release-proof/`; every applicable check must pass for `publishable: true`. Authentication-dependent model turns remain visibly `skipped` and non-applicable when credentials are unavailable because direct packed hook/MCP tests prove the deterministic criteria. Native role frontmatter is asserted as packaged static configuration; CLI init inventories are not represented as per-agent effective runtime permissions. Coverage enforces repository-wide V8 thresholds, while the test matrix exercises tools, hooks, concurrent persistence, corrupt-state recovery, project/path handling, security boundaries, and deterministic fixtures. CI runs checks on Node 20/22 across Linux, Windows, and macOS and validates both Claude manifests.

Programmatic APIs are exported from the package root, including `SessionStore`, `HorizonStore`, `detectProject`, `runVerification`, and `computeCoherenceScore`.

Run `parallax-claudecode doctor` for redacted Markdown or `parallax-claudecode doctor --json` for schema-versioned JSON. It checks actual Claude/Node versions, native registration/cache freshness, manifests and entrypoints, role declarations, config, canonical storage writeability, state/ledger/archive schemas, locks/queues, and package metadata. An unhealthy result includes remediation and exits nonzero.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Migration from parallax-opencode](docs/MIGRATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Support

- Found a bug? [Open a bug report](https://github.com/Master0fFate/parallax-claudecode/issues/new?template=bug_report.yml).
- Have an idea? [Request a feature](https://github.com/Master0fFate/parallax-claudecode/issues/new?template=feature_request.yml).
- For private vulnerability reports, follow the [security policy](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Master0fFate
