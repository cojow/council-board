# Safety and privacy

## What each provider receives

| Where | What |
|---|---|
| **Your computer** | The board: the event log (messages, help requests, claims), debate records, Codex run logs, per-project Codex consent, setup's backups. council-board itself sends nothing anywhere. It has no server and no telemetry, and it makes no network calls. |
| **Anthropic** | Each Claude agent is an ordinary Claude Code session on your account, so whatever it reads goes to Anthropic as part of that conversation, under your account's terms. That includes the board messages the hook hands it, the instructions generated from your policy, your house rules, and other agents' debate views once revealed. |
| **OpenAI** | Only when a Claude agent starts a Codex run, under your ChatGPT account's data settings. It sends the brief the agent wrote and the code Codex can see in that mode: the review sandbox, the read-only project, or its own copy. Codex gets no board tools and no board history beyond its brief. In debates, each Codex round sees only that round's material. |

A ChatGPT or Claude subscription is not by itself permission to share data that is restricted, for example by an ethics board, a data use agreement or a client contract. Keep such projects at Codex *off* or *review-only*, and keep raw data out of briefs.

## Codex consent and the review sandbox

- **Consent.** The launcher refuses to run in a project until you have answered "on / review-only / off" for it. It checks the answer again before every follow-up. Agents are told to record only an answer you gave in the conversation. Never add `codex.mjs run`, `consent` or `apply` to permission allow rules: keeping each one a prompt you see is part of the design.
- **Review sandbox (`--review`).** This is a temporary folder holding only the diff, the changed code files and the context files the agent names. Data files (such as CSV or Parquet) appear as name and size only. Files that look like credentials are withheld. That means files named like `.env`, private keys or `*credential*`/`*secret*`/`*token*`, or code whose text contains a private key, a cloud or API key pattern, or a hard-coded password. This is a heuristic, so don't rely on it alone for highly sensitive repositories. Use `--dry-run` to see exactly what Codex would get.
- **Edits.** These go to a separate git worktree on a `codex/…` branch, never to your folder. `apply` brings them in as uncommitted changes, only after you say yes, and refuses if they no longer fit.
- **Network.** Off by default.

## The hooks run on every step

Setup adds `hook.mjs` to four Claude Code hook events. That means it runs on **every prompt and every tool call** in every session of the connected accounts, in every project. On each call it:

- reads the hook event from stdin and the board's log (kept small: events older than two weeks are dropped once it passes 2 MB);
- prints new messages for this agent, if there are any;
- on `PreToolUse` for file edits, refuses edits to files another agent has claimed;
- on `Stop`, keeps the agent going once if messages just arrived;
- notes the session's model and effort (so help requests can carry them).

It doesn't make network calls, and it exits quickly when there is nothing to say. The timeout is 10 seconds. If `agents.json` or `policy.json` is broken, the hook exits with an error that Claude Code shows. That is a non-blocking error, so your session carries on, but messages and claim checks stop until you fix it. `doctor` names the problem.

## What setup changes

These changes are listed in the plan before anything is written, and recorded in `install-manifest.json`:

- each connected account's `settings.json` (hooks and one allow rule);
- the account's `commands/` folder;
- its user-scope MCP config, through the `claude mcp` CLI.

Every file is backed up first to `<config>/backups/<timestamp>/`. Setup never reads credential files. Uninstall removes exactly what the manifest lists. The backups may contain a copy of an account's `.claude.json`, which holds account metadata. They are created readable only by you; delete them when you no longer need them.

## Trust model and limits

- **The board trusts local processes.** Anything running as your user can write to the event log or the config. Messages carry an agent name, but nothing proves who wrote them. That's why agents treat board messages as information from a collaborator, never as instructions that override yours, and why Codex's output is verified, not obeyed.
- **Sealing in debates is procedural.** It prevents accidental exposure, not a determined reader of the log file.
- **The policy binds what the code checks.** Settings marked "instructions" in [policies.md](policies.md) depend on the agents following them.
- **Agents still need your OK for anything consequential.** Your own Claude Code permission settings still apply to everything else the agents do.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).
