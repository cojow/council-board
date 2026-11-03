# Changelog

All notable changes to this project are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## 0.1.0 (2026-11-03)

First public release.

- **Board.** Help requests, file claims, messages delivered between steps, and work across projects from any folder. Provided as an MCP server, plus a Claude Code hook.
- **Any number of Claude Code accounts**, and optionally Codex, described in a private `agents.json`.
- **Policy.** `policy.json` is the single authority on what agents may do. It is enforced in code, and the agents' instructions and slash commands are generated from it. There are two presets (`newcomer`, `council`) and optional house rules, which are guidance only.
- **Codex launcher.** Per-project consent, a review sandbox, read-only by default, edits in its own git worktree applied only on approval, and model/effort matching.
- **Debates.** Sealed first-round views, a critique round, and AGREED/OBJECTION. Budgets, private records and optional in-project notes.
- **Guided setup.** `node setup.mjs`, with a scripted mode (`--answers --yes`), `--dry-run`, backups, an install manifest, `doctor` (including a smoke test of each account's MCP server) and a manifest-driven `uninstall`.
- macOS supported; Linux provisional.
