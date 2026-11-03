# Security policy

## Supported versions

Only the latest release (currently 0.1.x) gets security fixes.

## Reporting a vulnerability

Please report it privately through GitHub: on this repository, open **Security → Report a vulnerability** (a private security advisory). Don't open a public issue for anything that could put users at risk.

Include what you found, how to reproduce it, and the impact you expect. You should hear back within a week. Once a fix is released, we'll credit you in the advisory unless you'd rather not be named.

## In scope

- `setup.mjs` changing files or settings beyond what its plan and manifest say, or uninstall removing things that aren't the board's
- The hook or MCP server letting one agent bypass another's file claims, or bypass a policy setting the code is meant to enforce
- The Codex launcher: Codex reaching your project folder without approval, the review sandbox exposing data files or credentials, `--write` runs escaping their worktree, shell injection or path traversal through its arguments, a run in a project without consent
- Debate sealing leaking first-round views through the board's tools before the reveal
- Anything in council-board that sends data off your computer (it should send none)

## Out of scope

- What Claude Code or Codex do with the data you choose to give them (see [docs/safety.md](docs/safety.md))
- Attacks that require already running code as your user. The board trusts local processes by design.
- Agents ignoring settings that are stated only in their instructions (marked "instructions" in [docs/policies.md](docs/policies.md))
