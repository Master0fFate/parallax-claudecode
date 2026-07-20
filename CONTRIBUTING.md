# Contributing

Thanks for helping make Parallax safer and more useful for Claude Code users.

## Before you start

- Search existing issues and pull requests before opening a duplicate.
- Use a focused issue for behavior changes that affect protocol enforcement, persistence, verification, or compatibility.
- Never include credentials, private traces, or real project state in fixtures.

## Development setup

```bash
git clone https://github.com/Master0fFate/parallax-claudecode.git
cd parallax-claudecode
npm ci
npm run check
```

Node.js 20 or newer is required. Test a checkout against Claude Code without installing it globally:

```bash
npm run build
npm run dev
```

## Pull requests

1. Keep the change narrow and explain the user-visible reason.
2. Add regression coverage for behavior changes and failure paths.
3. Run `npm run check` and strict validation for both Claude manifests.
4. Update public documentation when commands, policy, or compatibility changes.
5. Do not commit `dist`, coverage, `.parallax` state, local databases, package archives, or release-audit artifacts.

Commit messages should be concise and imperative, for example `fix: preserve repair permit after denied edit`.

## Design principles

- Prefer native Claude Code mechanisms over wrappers.
- Keep state session-scoped, atomic, and cross-process safe.
- Fail closed at mutation and verification trust boundaries.
- Preserve bounded retries and honest residual limitations.
- Avoid shell interpolation for repository-controlled commands.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
