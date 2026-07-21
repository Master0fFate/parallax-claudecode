# Changelog

All notable changes to Parallax for Claude Code are documented here. This project follows [Semantic Versioning](https://semver.org/).

## Unreleased

## [0.2.0] - 2026-07-22

### Added

- Reusable schema-versioned lifecycle doctor with CLI, MCP, and status integration; redacted Markdown and machine JSON cover versions, native registration/cache freshness, entrypoints, permissions, config, storage, schemas, locks, queues, ledger archives, and metadata.
- Native uninstall forwarding with `--keep-data`, idempotent update guidance, archive integrity/ownership checks, and lifecycle/recovery documentation.

### Changed

- Documented the runtime/permission/prompt/observed guarantee boundaries and Claude Code 2.1.215 foreground Horizon limitation; removed score-backed acceptance claims.

## [0.1.1] - 2026-07-20

### Fixed

- Canonicalized temporary project paths in cross-platform MCP tests.
- Treated transient Windows `EPERM`/`EACCES` lock-stat races as contention instead of fatal corruption.
- Preserved compatibility with trace state created by 0.1.0.
- Updated GitHub Actions to current Node 24-based action runtimes.

## [0.1.0] - 2026-07-20

### Added

- Native Claude Code plugin with nine lifecycle hooks, nine skills, and two focused agents.
- Bundled MCP server exposing 37 Parallax, Hyperplan, trace, doctor, health, and Horizon tools.
- Session-scoped atomic state, linked traces, coherence scoring, and bounded repair behavior.
- Project-aware verification for Node.js, Python, Go, Rust, and .NET repositories.
- Durable Horizon execution with independent verification and migration from legacy OpenCode state.
- Cross-platform npm installer, strict package checks, and Node 20/22 CI across Linux, macOS, and Windows.

[0.1.1]: https://github.com/Master0fFate/parallax-claudecode/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Master0fFate/parallax-claudecode/releases/tag/v0.1.0
[0.2.0]: https://github.com/Master0fFate/parallax-claudecode/compare/v0.1.1...v0.2.0
