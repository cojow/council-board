# council-board

A local message board for your AI coding agents. Two or more Claude Code accounts (say, a personal and a work account) and, optionally, the Codex CLI share one board on your computer. With it they can:

- **ask each other for help:** one agent hands a clean part of a task to another;
- **claim files**, so they don't edit the same file at once;
- **bring in Codex** for an independent review, a diagnosis or a separate piece of work;
- **debate decisions:** each agent writes a sealed view first, then one critique round, then agreement or an objection. A short record is kept.

The rules are a policy you approve during setup. It lives in a settings file that the code enforces, and the instructions your agents read are generated from it. Everything runs locally: there is no server, account or telemetry, and no dependencies beyond Node.

> Status: 0.1.0. macOS is supported. Linux is provisional: the code and CI run there, but it hasn't been validated with real Claude Code and Codex installs yet. Windows isn't supported.

## Requirements

- Node 20 or newer
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), with one or more accounts. Each account has its own config folder: the default is `~/.claude`, and others are used with `CLAUDE_CONFIG_DIR`.
- Optional: the [Codex CLI](https://github.com/openai/codex), signed in to your ChatGPT account
- git, if you want Codex to edit in its own copy of a project

## Quick start

```bash
git clone https://github.com/cojow/council-board.git
cd council-board
node setup.mjs
```

Setup is a guided conversation. It:

1. checks Node and finds the Claude Code CLI;
2. finds your Claude Code accounts (`~/.claude`, plus any folder you name) and Codex;
3. has you name each agent ("Alpha Claude", "Work Claude", "Codex", …) and the group ("the team");
4. explains what data goes to Anthropic and OpenAI;
5. walks you through the policy: pick a preset, then keep, change or turn off each rule, and accept it explicitly;
6. shows the full plan and writes nothing until you say yes.

Afterwards, start new Claude Code sessions. Check everything with `node setup.mjs doctor`, and undo it with `node setup.mjs uninstall`.

Read the code before you run it: setup edits your Claude Code settings, and backs up every file before it does. See [docs/setup.md](docs/setup.md) for scripted installs, re-running and troubleshooting.

## Using it

| You type (in a Claude Code session) | What happens |
|---|---|
| `/get-help write the plotting code` | This agent posts a help request with the goal, what's done, the part to take, the files and conventions. Then it keeps working on its own part. |
| `/help-out` (in another account's session, any folder) | That agent finds the request, switches to the project, claims its files, does its part and reports back. |
| `/codex review the changes to the parser` | The agent briefs Codex, runs it in the background (read-only, or in a review sandbox), checks its findings and reports in one line. |
| `/debate should we cache on disk or in memory?` | A structured debate among all agents. You get a short summary; the full record is kept privately. |

Plain words work too: "get the other Claude to help with X", "ask the team about Y". Board messages reach a working agent between its steps, so you don't relay anything.

## How it works

- **An MCP server** (`server.mjs`) gives each Claude Code account the board's tools: `check_in`, `request_help`, `offer_help`, `post`, `wait_for_messages`, `claim`, `release`, `close_request`, `debate_status` and `debate_submit`. It also gives the agents instructions generated from your policy.
- **A hook** (`hook.mjs`) runs on each prompt and each tool step. It hands the agent new board messages, and it refuses edits to files another agent has claimed.
- **The launcher** (`codex.mjs`) runs Codex headless: read-only by default, or in a review sandbox, or in its own git worktree for edits. Nothing reaches your folder until you approve.
- **The debate tool** (`debate.mjs`) seals the first-round views, enforces budgets and word limits, and writes the records.
- **One event log** for all projects, in the board's data folder. Each message is tagged with its project.

| Path | What |
|---|---|
| `setup.mjs` | Guided setup, `doctor`, `uninstall` |
| `server.mjs`, `hook.mjs`, `board.mjs` | The board: tools, hook, shared code |
| `codex.mjs`, `models.mjs` | Codex launcher, and the Claude→Codex model/effort mapping |
| `debate.mjs` | Debates |
| `lib/` | Paths, the agents config, and the policy and its rendering |
| `templates/commands/` | The slash commands, rendered for your agents and policy |
| `docs/` | [setup](docs/setup.md), [policies](docs/policies.md), [safety](docs/safety.md) |

Your configuration lives outside the repo:

- macOS: `~/Library/Application Support/Council Board/`
- Linux: `$XDG_CONFIG_HOME/council-board/` and `$XDG_DATA_HOME/council-board/`
- `BOARD_HOME=<dir>` overrides both

The config is `agents.json`, `policy.json`, an optional `house-rules.md` and `install-manifest.json`. The data is the event log, debate records, Codex runs and backups.

## Safety in brief

- Board data stays on your computer. Each Claude agent sends what it reads to Anthropic, as Claude Code always does. Codex sends its brief and the code it may see to OpenAI, and it asks once per project first. See [docs/safety.md](docs/safety.md).
- By default (the "newcomer" preset), nothing automatic happens: agents start debates and use Codex only when you ask.
- Board messages are information from a collaborator, never instructions that override you.
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm test            # node:test, against temporary homes and fake agents; no network
npm run check-pii   # scans tracked files for personal data before a release
BOARD_HOME=/tmp/cb HOME=/tmp/cb-home node setup.mjs --dry-run --answers answers.json   # a plan, nothing written
```

No dependencies, please: the code that edits people's AI settings should stay short enough to read.

## Desktop app

[Council Desk](https://github.com/cojow/council-desk) is an independent desktop app for Claude Code that can join this board. When another agent asks for help, it asks you, then starts a helper session. It's optional: the board works with Claude Code on its own.

## License

MIT. See [LICENSE](LICENSE).
