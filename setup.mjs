#!/usr/bin/env node
// Guided setup for council-board: names your agents, walks you through the policies, then
// connects each Claude Code account to the board (MCP server, hooks, commands).
//
//   node setup.mjs                      guided setup (asks before writing anything)
//   node setup.mjs --dry-run            the same, but only prints the plan
//   node setup.mjs --answers <file|json> --yes [--dry-run]    scripted setup (see docs/setup.md)
//   node setup.mjs doctor               check the config and every account's connection
//   node setup.mjs uninstall [--purge] [--yes] [--dry-run]   undo what setup wrote
//   --claude-bin <path>                 the Claude Code CLI, if it isn't on PATH (or CLAUDE_BIN)
//
// Safety: every file is backed up to <config>/backups/<timestamp>/ before it changes, and
// everything setup adds is recorded in <config>/install-manifest.json, which uninstall
// follows. Re-running setup replaces its own entries and leaves everything else alone.
// Setup never reads credentials: it touches each account's settings.json and commands/,
// and lets the Claude Code CLI add the MCP server.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { AGENTS_FILE, findCodexBin, loadAgents, validateAgents } from './lib/config.mjs';
import { CONFIG_DIR, DATA_DIR, expandHome } from './lib/paths.mjs';
import { HOUSE_RULES_FILE, NEWCOMER, POLICY_FILE, PRESETS, RULES, describePolicy, getPath, merge, setPath, validatePolicy } from './lib/policy.mjs';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = path.join(REPO, 'hook.mjs');
const SERVER_SCRIPT = path.join(REPO, 'server.mjs');
const TEMPLATES = path.join(REPO, 'templates', 'commands');
const MANIFEST_FILE = path.join(CONFIG_DIR, 'install-manifest.json');
const MARKER = '<!-- council-board -->';
const OUR_MARKERS = [MARKER, '<!-- claude-board -->']; // the second: installs from before the rename
const HOOK_EVENTS = [
  { event: 'UserPromptSubmit' },
  { event: 'PostToolUse', matcher: '*' },
  { event: 'PreToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  { event: 'Stop' },
];
const COMMANDS = ['get-help', 'help-out', 'codex', 'debate'];
const ALLOW_RULE = 'mcp__board';

// ---------- small helpers ----------

const HOME = () => process.env.HOME || os.homedir();
const tilde = (p) => (p && (p === HOME() || p.startsWith(HOME() + path.sep)) ? '~' + p.slice(HOME().length) : p);
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);
const abs = (p) => path.resolve(expandHome(p));
const exists = (p) => fs.existsSync(p);
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${tilde(file)} isn't valid JSON (${error.message}). Fix it by hand first; setup won't overwrite a file it can't read.`);
  }
}
const writeJson = (file, obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
};

function parseArgs(argv) {
  const opts = { cmd: 'setup', yes: false, dryRun: false, purge: false, answers: null, claudeBin: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'doctor' || a === 'uninstall' || a === 'setup') opts.cmd = a;
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--purge') opts.purge = true;
    else if (a === '--answers') opts.answers = argv[++i];
    else if (a === '--claude-bin') opts.claudeBin = argv[++i];
    else if (a === '--help' || a === '-h') opts.cmd = 'help';
    else throw new Error(`Unknown argument: ${a} (try --help)`);
  }
  return opts;
}

// The Claude Code CLI: --claude-bin, CLAUDE_BIN, `claude` on PATH, or a usual install place.
function findClaudeBin(given) {
  const candidates = [given, process.env.CLAUDE_BIN].filter(Boolean).map(abs);
  try {
    const onPath = execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (onPath) candidates.push(onPath);
  } catch {}
  candidates.push(path.join(HOME(), '.claude', 'local', 'claude'), path.join(HOME(), '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  return candidates.find(isFile) || null;
}

// Where Claude Code keeps an account's user-scope MCP servers.
const isDefaultAccount = (dir) => abs(dir) === abs('~/.claude');
const claudeJsonFor = (dir) => (isDefaultAccount(dir) ? path.join(HOME(), '.claude.json') : path.join(abs(dir), '.claude.json'));
function accountEnv(dir) {
  const env = { ...process.env };
  if (isDefaultAccount(dir)) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = abs(dir);
  return env;
}

// The node that runs the server and hook: `node` on PATH if it is this same node (a stable
// link such as /opt/homebrew/bin/node survives upgrades; a versioned path doesn't), else this one.
// An absolute path, because apps that start Claude Code often don't have node on their PATH.
let nodeBinCache = null;
function nodeBin() {
  if (nodeBinCache) return nodeBinCache;
  nodeBinCache = process.execPath;
  try {
    const onPath = execFileSync('/bin/sh', ['-lc', 'command -v node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (onPath && fs.realpathSync(onPath) === fs.realpathSync(process.execPath)) nodeBinCache = onPath;
  } catch {}
  return nodeBinCache;
}

// Environment the board's server and hook need besides the agent id.
const extraEnv = () => (process.env.BOARD_HOME ? { BOARD_HOME: abs(process.env.BOARD_HOME) } : {});
const hookCommand = (id) => [`BOARD_AGENT=${id}`, ...Object.entries(extraEnv()).map(([k, v]) => `${k}=${shq(v)}`), shq(nodeBin()), shq(HOOK_SCRIPT)].join(' ');
const isOurHookEntry = (entry) => entry?.hooks?.some((h) => String(h.command || '').includes(HOOK_SCRIPT));
const isOurs = (file) => {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return OUR_MARKERS.some((m) => text.includes(m));
  } catch {
    return false;
  }
};
function boardServer(dir) {
  const server = readJson(claudeJsonFor(dir), {})?.mcpServers?.board;
  return server ? { ...server, ours: (server.args || []).includes(SERVER_SCRIPT) } : null;
}

// ---------- rendering the commands ----------

const listNames = (names) => {
  const q = names.map((n) => `"${n}"`);
  return q.length > 1 ? `${q.slice(0, -1).join(', ')} and ${q.at(-1)}` : q[0] || '';
};

export function renderTemplate(text, { boardDir, group, agents, codex, policy }) {
  const dir = /^[\w@%+=:,./-]+$/.test(boardDir) ? boardDir : `"${boardDir}"`;
  return text.replace(/\{\{([\w.]+)\}\}/g, (all, key) => {
    if (key === 'BOARD_DIR') return dir;
    if (key === 'GROUP') return group;
    if (key === 'AGENTS') return listNames(agents.map((a) => a.name));
    if (key === 'CODEX') return codex?.name || 'Codex';
    if (key.startsWith('policy.')) {
      const v = getPath(policy, key.slice(7));
      if (v !== undefined && typeof v !== 'object') return String(v);
    }
    throw new Error(`Unknown placeholder ${all} in a command template`);
  });
}

function wantedCommands(agentsConfig, policy) {
  const codex = agentsConfig.agents.find((a) => a.kind === 'codex');
  return COMMANDS.filter((c) => (c === 'codex' ? codex && policy.codex.enabled : c === 'debate' ? policy.debates.enabled : true));
}

function renderCommands(agentsConfig, policy) {
  const ctx = { boardDir: REPO, group: agentsConfig.groupName, agents: agentsConfig.agents, codex: agentsConfig.agents.find((a) => a.kind === 'codex'), policy };
  const wanted = wantedCommands(agentsConfig, policy);
  return Object.fromEntries(wanted.map((c) => [c, renderTemplate(fs.readFileSync(path.join(TEMPLATES, `${c}.md`), 'utf8'), ctx)]));
}

// ---------- answers -> config ----------

const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';

// Turns setup answers (from the questions or an --answers file) into agents.json, policy.json
// and house rules. Throws with every problem found.
export function normalizeAnswers(answers) {
  if (!answers || typeof answers !== 'object') throw new Error('answers must be a JSON object');
  const used = new Set();
  const agents = (answers.agents || []).map((a) => {
    let id = a.id || slug(a.name);
    for (let n = 2; used.has(id); n++) id = `${(a.id || slug(a.name)).slice(0, 29)}-${n}`;
    used.add(id);
    const out = { id, name: String(a.name || '').trim(), kind: a.kind };
    if (a.kind === 'claude-code') out.configDir = tilde(abs(a.configDir || '~/.claude'));
    if (a.kind === 'codex') out.bin = a.bin ? tilde(abs(a.bin)) : null;
    const aliases = (a.aliases || []).map((x) => String(x).trim()).filter(Boolean);
    if (aliases.length) out.aliases = aliases;
    return out;
  });
  const agentsConfig = { version: 1, groupName: String(answers.groupName || 'the team').trim(), agents };
  const problems = validateAgents(agentsConfig);
  if (!agents.some((a) => a.kind === 'claude-code')) problems.push('at least one Claude Code account is needed');
  const dirs = agents.filter((a) => a.kind === 'claude-code').map((a) => abs(a.configDir));
  if (new Set(dirs).size !== dirs.length) problems.push('two agents use the same Claude Code folder');

  const preset = answers.preset || 'newcomer';
  if (!PRESETS[preset]) problems.push(`preset must be one of ${Object.keys(PRESETS).join(', ')}`);
  let policy = merge(PRESETS[preset] || NEWCOMER, answers.policy || {});
  policy = { ...policy, version: 1, preset };
  if (!agents.some((a) => a.kind === 'codex')) policy = setPath(policy, 'codex.enabled', false);
  problems.push(...validatePolicy(policy));
  if (problems.length) throw new Error(`The answers have problems:\n- ${problems.join('\n- ')}`);
  const houseRules = typeof answers.houseRules === 'string' ? answers.houseRules.trim() : null;
  return { agentsConfig, policy, houseRules, acceptPolicy: answers.acceptPolicy === true, claudeBin: answers.claudeBin || null };
}

// ---------- the plan ----------

function buildPlan({ agentsConfig, policy, houseRules }, claudeBin) {
  const manifest = readJson(MANIFEST_FILE, null);
  const commands = renderCommands(agentsConfig, policy);
  const accounts = agentsConfig.agents.filter((a) => a.kind === 'claude-code').map((agent) => {
    const dir = abs(agent.configDir);
    const previous = manifest?.accounts?.find((x) => x.configDir === dir);
    const settingsFile = path.join(dir, 'settings.json');
    const settings = readJson(settingsFile, {});
    const allow = settings.permissions?.allow || [];
    const cmds = COMMANDS.map((c) => {
      const target = path.join(dir, 'commands', `${c}.md`);
      const has = exists(target);
      if (commands[c]) return { name: c, target, content: commands[c], action: !has || isOurs(target) ? 'write' : 'keep-yours' };
      return { name: c, target, action: has && isOurs(target) ? 'remove' : 'skip' };
    });
    return {
      agent,
      dir,
      settingsFile,
      claudeJson: claudeJsonFor(dir),
      hookCommand: hookCommand(agent.id),
      addedAllow: previous?.addedAllow || !allow.includes(ALLOW_RULE),
      // Files and folders setup creates, so uninstall can remove them again if they end up empty.
      createdSettings: previous?.createdSettings || !exists(settingsFile),
      createdCommandsDir: previous?.createdCommandsDir || !exists(path.join(dir, 'commands')),
      existingServer: boardServer(dir),
      commands: cmds,
    };
  });
  const keptDirs = new Set(accounts.map((a) => a.dir));
  const dropped = (manifest?.accounts || []).filter((a) => !keptDirs.has(a.configDir));
  return { agentsConfig, policy, houseRules, claudeBin, accounts, dropped, manifest };
}

function mcpAddArgs(agent) {
  const env = { BOARD_AGENT: agent.id, ...extraEnv() };
  return ['mcp', 'add', '-s', 'user', 'board', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', nodeBin(), SERVER_SCRIPT];
}

function printPlan(plan) {
  const { agentsConfig, policy, houseRules, accounts, dropped, claudeBin } = plan;
  const lines = ['', 'The plan (nothing is written until you say yes):', `  In ${tilde(CONFIG_DIR)}:`];
  lines.push(`    agents.json: ${agentsConfig.agents.map((a) => `${a.name} (${a.kind})`).join(', ')}; together "${agentsConfig.groupName}"`);
  lines.push(`    policy.json: based on the "${policy.preset}" preset${exists(POLICY_FILE) ? ' (replaces the current one)' : ''}`);
  lines.push(`    house-rules.md: ${houseRules === null ? (exists(HOUSE_RULES_FILE) ? 'kept as it is' : 'none') : houseRules ? 'written' : 'removed'}`);
  for (const a of accounts) {
    lines.push(`  Claude Code account "${a.agent.name}" (${tilde(a.dir)}):`);
    const replacing = a.existingServer && !a.existingServer.ours ? ` (replaces your existing "board" server: ${[a.existingServer.command, ...(a.existingServer.args || [])].join(' ')})` : '';
    lines.push(`    MCP server "board", user scope${replacing}: ${tilde(claudeBin || 'claude')} ${mcpAddArgs(a.agent).map((x) => shq(tilde(x))).join(' ')}`);
    lines.push(`    settings.json: hooks on ${HOOK_EVENTS.map((h) => h.event + (h.matcher ? ` (${h.matcher})` : '')).join(', ')}, running: ${a.hookCommand}`);
    lines.push(`    settings.json: allow the board's tools without prompts ("${ALLOW_RULE}")`);
    const by = (act) => a.commands.filter((c) => c.action === act).map((c) => `/${c.name}`);
    if (by('write').length) lines.push(`    commands: ${by('write').join(', ')}`);
    if (by('keep-yours').length) lines.push(`    commands kept (you have your own file): ${by('keep-yours').join(', ')}`);
    if (by('remove').length) lines.push(`    commands removed (turned off in the policy): ${by('remove').join(', ')}`);
  }
  for (const d of dropped) lines.push(`  No longer an agent, so the board is removed from: ${tilde(d.configDir)}`);
  lines.push(`  Backups of every file before it changes: ${tilde(path.join(CONFIG_DIR, 'backups'))}/<timestamp>/`);
  console.log(lines.join('\n'));
}

// ---------- writing ----------

function makeBackup(stamp) {
  const dir = path.join(CONFIG_DIR, 'backups', stamp);
  const copies = [];
  const backup = (file) => {
    if (!exists(file) || copies.some((c) => c.file === file)) return;
    const copy = path.join(dir, path.resolve(file).replace(/^[/\\]+/, ''));
    fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, 0o600);
    copies.push({ file, copy });
  };
  return { dir, copies, backup };
}

function runClaude(claudeBin, args, dir, { quiet = false } = {}) {
  execFileSync(claudeBin, args, { env: accountEnv(dir), stdio: quiet ? 'ignore' : ['ignore', 'inherit', 'inherit'], timeout: 60000 });
}

function wireAccount(a, claudeBin, backup) {
  // MCP server, through the Claude Code CLI.
  backup(a.claudeJson);
  try {
    runClaude(claudeBin, ['mcp', 'remove', 'board', '-s', 'user'], a.dir, { quiet: true });
  } catch {}
  runClaude(claudeBin, mcpAddArgs(a.agent), a.dir);

  // Hooks and the allow rule.
  backup(a.settingsFile);
  const settings = readJson(a.settingsFile, {});
  settings.hooks ||= {};
  for (const { event, matcher } of HOOK_EVENTS) {
    const list = (settings.hooks[event] || []).filter((e) => !isOurHookEntry(e));
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: a.hookCommand, timeout: 10 }] });
    settings.hooks[event] = list;
  }
  settings.permissions ||= {};
  settings.permissions.allow = [...new Set([...(settings.permissions.allow || []), ALLOW_RULE])];
  writeJson(a.settingsFile, settings);

  // Commands.
  const written = [];
  for (const c of a.commands) {
    if (c.action === 'write') {
      backup(c.target);
      fs.mkdirSync(path.dirname(c.target), { recursive: true });
      fs.writeFileSync(c.target, c.content);
      written.push(c.target);
    } else if (c.action === 'remove') {
      backup(c.target);
      fs.rmSync(c.target);
    }
  }
  return { agentId: a.agent.id, configDir: a.dir, settingsFile: a.settingsFile, claudeJson: a.claudeJson, hookCommand: a.hookCommand, addedAllow: a.addedAllow, createdSettings: a.createdSettings, createdCommandsDir: a.createdCommandsDir, commands: written };
}

// Removes what setup added to one account (as recorded in the manifest).
function unwireAccount(rec, claudeBin, backup, log = console.log) {
  if (exists(rec.settingsFile)) {
    backup(rec.settingsFile);
    const settings = readJson(rec.settingsFile, {});
    for (const event of Object.keys(settings.hooks || {})) {
      const list = (settings.hooks[event] || []).filter((e) => !isOurHookEntry(e));
      if (list.length) settings.hooks[event] = list;
      else delete settings.hooks[event];
    }
    if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
    if (rec.addedAllow && settings.permissions?.allow) {
      settings.permissions.allow = settings.permissions.allow.filter((r) => r !== ALLOW_RULE);
      if (!settings.permissions.allow.length) delete settings.permissions.allow;
      if (!Object.keys(settings.permissions).length) delete settings.permissions;
    }
    if (rec.createdSettings && !Object.keys(settings).length) fs.rmSync(rec.settingsFile);
    else writeJson(rec.settingsFile, settings);
  }
  for (const file of rec.commands || []) {
    if (!exists(file)) continue;
    if (isOurs(file)) {
      backup(file);
      fs.rmSync(file);
    } else log(`  kept ${tilde(file)} (it no longer looks like ours)`);
  }
  const commandsDir = path.join(rec.configDir, 'commands');
  if (rec.createdCommandsDir && exists(commandsDir) && !fs.readdirSync(commandsDir).length) fs.rmdirSync(commandsDir);
  const server = boardServer(rec.configDir);
  if (server?.ours) {
    backup(rec.claudeJson);
    if (claudeBin) runClaude(claudeBin, ['mcp', 'remove', 'board', '-s', 'user'], rec.configDir, { quiet: true });
    else {
      // No CLI: remove just our entry from the file the CLI would have changed.
      const json = readJson(rec.claudeJson, {});
      delete json.mcpServers.board;
      writeJson(rec.claudeJson, json);
    }
  } else if (server) log(`  kept the "board" MCP server in ${tilde(rec.configDir)} (it isn't this copy's)`);
}

function applyPlan(plan) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const { backup, copies, dir: backupDir } = makeBackup(stamp);
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });

  for (const f of [AGENTS_FILE, POLICY_FILE]) backup(f);
  writeJson(AGENTS_FILE, plan.agentsConfig);
  writeJson(POLICY_FILE, plan.policy);
  if (plan.houseRules !== null) {
    backup(HOUSE_RULES_FILE);
    if (plan.houseRules) fs.writeFileSync(HOUSE_RULES_FILE, plan.houseRules + '\n');
    else fs.rmSync(HOUSE_RULES_FILE, { force: true });
  }

  for (const d of plan.dropped) {
    console.log(`Removing the board from ${tilde(d.configDir)}`);
    unwireAccount(d, plan.claudeBin, backup);
  }
  const accounts = [];
  for (const a of plan.accounts) {
    console.log(`Connecting "${a.agent.name}" (${tilde(a.dir)})`);
    accounts.push(wireAccount(a, plan.claudeBin, backup));
  }

  const manifest = {
    version: 1,
    repo: REPO,
    node: nodeBin(),
    boardHome: extraEnv().BOARD_HOME || null,
    installedAt: plan.manifest?.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    configFiles: [AGENTS_FILE, POLICY_FILE, ...(exists(HOUSE_RULES_FILE) ? [HOUSE_RULES_FILE] : [])],
    accounts,
    backups: [...(plan.manifest?.backups || []), ...(copies.length ? [{ dir: backupDir, files: copies }] : [])],
  };
  writeJson(MANIFEST_FILE, manifest);
  return manifest;
}

// ---------- smoke test: start the MCP server as an agent and list its tools ----------

export function smokeTest(agent, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER_SCRIPT], { cwd: os.tmpdir(), env: { ...process.env, BOARD_AGENT: agent.id, ...extraEnv() }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, problem: `no answer within ${timeoutMs / 1000}s${err ? `: ${err.trim().split('\n').at(-1)}` : ''}` }), timeoutMs);
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => finish({ ok: false, problem: `the server exited (code ${code})${err ? `: ${err.trim().split('\n').at(-1)}` : ''}` }));
    child.stdout.on('data', (d) => {
      out += d;
      const msgs = out.split('\n').filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      });
      const init = msgs.find((m) => m?.id === 1);
      const list = msgs.find((m) => m?.id === 2);
      if (!init || !list) return;
      const tools = (list.result?.tools || []).map((t) => t.name);
      const instructions = init.result?.instructions || '';
      if (!tools.includes('offer_help')) finish({ ok: false, problem: 'the server answered but has no board tools' });
      else if (!instructions.includes(`You are ${agent.name}.`)) finish({ ok: false, problem: `the server doesn't know it is "${agent.name}"` });
      else finish({ ok: true, tools: tools.length });
    });
    const send = (m) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'council-board-setup', version: '0' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
  });
}

// ---------- questions ----------

function makeAsker() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, def = '') => {
    const a = (await rl.question(`${q}${def !== '' ? ` [${def}]` : ''} `)).trim();
    return a === '' ? String(def) : a;
  };
  const yesNo = async (q, def = true) => {
    for (;;) {
      const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase();
      if (a === '') return def;
      if (['y', 'yes'].includes(a)) return true;
      if (['n', 'no'].includes(a)) return false;
    }
  };
  return { ask, yesNo, close: () => rl.close() };
}

const DATA_NOTE = `
What goes where:
  - The board itself (messages, claims, help requests, debate records) stays on this
    computer, in ${tilde(DATA_DIR)}. council-board has no server and no telemetry.
  - Each Claude agent is a Claude Code session on your Anthropic account. Whatever it reads,
    including board messages the hook hands it and the instructions generated from your
    policy, is sent to Anthropic as part of that conversation, as usual for Claude Code.
  - Codex (if you add it) runs on your ChatGPT account. When a Claude starts a Codex run,
    the brief and the project code Codex is allowed to see are sent to OpenAI. Codex asks
    once per project (on / review-only / off) before it reads anything there.
  - Setup never reads your credentials. It changes each account's settings.json and
    commands/ folder, and the Claude Code CLI adds the MCP server to that account.`;

function defaultName(dir) {
  const base = path.basename(dir).replace(/^\./, '');
  if (base === 'claude') return 'Main Claude';
  const rest = base.replace(/^claude[-_]?/, '') || base;
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)} Claude`;
}

function candidateAccounts() {
  const found = new Set();
  if (exists(abs('~/.claude'))) found.add(abs('~/.claude'));
  if (process.env.CLAUDE_CONFIG_DIR && exists(abs(process.env.CLAUDE_CONFIG_DIR))) found.add(abs(process.env.CLAUDE_CONFIG_DIR));
  for (const name of fs.readdirSync(HOME()).sort()) {
    const p = path.join(HOME(), name);
    if (/^\.claude[-_.]\w/.test(name) && fs.statSync(p).isDirectory() && exists(path.join(p, 'settings.json'))) found.add(p);
  }
  return [...found];
}

async function askPolicy(io, base, hasCodex) {
  let policy = base;
  if (!hasCodex) policy = setPath(policy, 'codex.enabled', false);
  const skipped = (r) =>
    (r.key.startsWith('codex.') && (!hasCodex || (r.key !== 'codex.enabled' && !policy.codex.enabled))) ||
    (r.key.startsWith('debates.') && r.key !== 'debates.enabled' && !policy.debates.enabled) ||
    (r.key === 'debates.minConfidence' && !policy.debates.aiDecisions) ||
    (r.key === 'collaboration.claimHours' && !policy.collaboration.claims);
  console.log('\nFor each rule: press Enter to keep it, or give a new value.');
  for (const r of RULES) {
    if (skipped(r)) continue;
    const v = getPath(policy, r.key);
    console.log(`\n${r.label}: ${r.type === 'bool' ? (v ? 'on' : 'off') : v}\n  ${r.explain}`);
    for (;;) {
      const a = (await io.ask(r.type === 'bool' ? '  on / off?' : `  value (${r.min} to ${r.max})?`, '')).toLowerCase();
      if (a === '') break;
      if (r.type === 'bool' && ['on', 'off', 'y', 'n', 'yes', 'no', 'true', 'false'].includes(a)) {
        policy = setPath(policy, r.key, ['on', 'y', 'yes', 'true'].includes(a));
        break;
      }
      const n = Number(a);
      if (r.type !== 'bool' && a !== '' && !Number.isNaN(n) && n >= r.min && n <= r.max && (r.type !== 'int' || Number.isInteger(n))) {
        policy = setPath(policy, r.key, n);
        break;
      }
      console.log(r.type === 'bool' ? '  Please answer on or off (or Enter to keep).' : `  Please give ${r.type === 'int' ? 'a whole number' : 'a number'} from ${r.min} to ${r.max} (or Enter to keep).`);
    }
  }
  return policy;
}

async function interview(opts) {
  const io = makeAsker();
  try {
    console.log('council-board setup\n===================\nThis connects your AI agents (Claude Code accounts and, optionally, Codex) to a shared\nmessage board on this computer. Nothing is written until you approve the full plan.');
    let previous = null;
    try {
      previous = loadAgents({ fresh: true });
    } catch (e) {
      console.log(`\nNote: ${e.message}`);
    }
    let previousPolicy = readJson(POLICY_FILE, null);

    // Claude Code
    let claudeBin = findClaudeBin(opts.claudeBin);
    if (claudeBin) console.log(`\nClaude Code CLI: ${tilde(claudeBin)}`);
    while (!claudeBin) {
      const p = await io.ask("\nI can't find the Claude Code CLI (`claude`). Its path, or Enter to stop:");
      if (!p) throw new Error('Setup needs the Claude Code CLI. Install it (see docs/setup.md), or pass --claude-bin <path>.');
      claudeBin = isFile(abs(p)) ? abs(p) : (console.log('  Not a file.'), null);
    }

    // Accounts
    console.log('\nClaude Code accounts. Each account has its own folder (the default is ~/.claude; others are\nused with CLAUDE_CONFIG_DIR). Each one you pick becomes an agent on the board.');
    const dirs = [];
    for (const d of candidateAccounts()) if (await io.yesNo(`  Use ${tilde(d)}?`, true)) dirs.push(d);
    for (;;) {
      const p = await io.ask('  Another account folder (Enter when done):');
      if (!p) {
        if (dirs.length) break;
        console.log('  At least one account is needed.');
        continue;
      }
      const d = abs(p);
      if (!exists(d) && !(await io.yesNo(`  ${tilde(d)} doesn't exist yet. Use it anyway?`, false))) continue;
      if (!dirs.includes(d)) dirs.push(d);
    }

    // Codex
    let codexBin = null;
    try {
      codexBin = findCodexBin();
    } catch {}
    let useCodex = false;
    if (codexBin) useCodex = await io.yesNo(`\nFound Codex at ${tilde(codexBin)}. Add Codex as a worker?`, true);
    else {
      const p = await io.ask("\nI didn't find the Codex CLI. Its path to add Codex, or Enter to skip:");
      if (p && isFile(abs(p))) [useCodex, codexBin] = [true, abs(p)];
      else if (p) console.log('  Not a file; skipping Codex (run setup again to add it later).');
    }

    // Names
    console.log('\nNames. This is how each agent appears on the board. Aliases are other names you may use for it.');
    const agents = [];
    const prevOf = (pred) => previous?.agents?.find(pred);
    for (const d of dirs) {
      const prev = prevOf((a) => a.kind === 'claude-code' && abs(a.configDir) === d);
      const name = await io.ask(`  Name for the account in ${tilde(d)}:`, prev?.name || defaultName(d));
      const aliases = await io.ask(`  Aliases for ${name} (comma-separated, Enter for none):`, (prev?.aliases || []).join(', '));
      agents.push({ id: prev?.id, name, kind: 'claude-code', configDir: d, aliases: aliases.split(',') });
    }
    if (useCodex) {
      const prev = prevOf((a) => a.kind === 'codex');
      const name = await io.ask('  Name for Codex:', prev?.name || 'Codex');
      const aliases = await io.ask(`  Aliases for ${name} (comma-separated, Enter for none):`, (prev?.aliases || []).join(', '));
      agents.push({ id: prev?.id, name, kind: 'codex', bin: codexBin, aliases: aliases.split(',') });
    }
    const groupName = await io.ask('  What do you call all of them together?', previous?.groupName || 'the team');

    console.log(DATA_NOTE);
    if (!(await io.yesNo('\nContinue?', true))) throw new Error('Stopped; nothing was written.');

    // Policies
    console.log('\nPolicies. These decide what the agents may do by themselves. Code enforces them, and the\ninstructions the agents read are generated from them. See docs/policies.md.\n  newcomer: helpers and debates only when you ask; Codex only when you ask (recommended to start)\n  council:  agents may start debates and bring in Codex by themselves, within budgets');
    if (previousPolicy) {
      try {
        previousPolicy = merge(NEWCOMER, previousPolicy);
        if (validatePolicy(previousPolicy).length) previousPolicy = null;
      } catch {
        previousPolicy = null;
      }
    }
    const choices = [...(previousPolicy ? ['current'] : []), ...Object.keys(PRESETS)];
    let base;
    for (;;) {
      const a = await io.ask(`Start from which? (${choices.join(' / ')})`, choices[0]);
      if (choices.includes(a)) {
        base = a === 'current' ? previousPolicy : PRESETS[a];
        break;
      }
    }
    let policy;
    for (;;) {
      policy = await askPolicy(io, base, useCodex);
      console.log(`\nThe policy you chose:\n${describePolicy(policy)}`);
      const a = (await io.ask('\nType "accept" to accept it, "change" to go through it again, or "quit":')).toLowerCase();
      if (a === 'accept') break;
      if (a === 'quit') throw new Error('Stopped; nothing was written.');
      base = policy;
    }

    // House rules
    let houseRules = null;
    console.log(`\nHouse rules (optional): a Markdown file of guidance in your own words, appended to the\nagents' instructions. It can't grant permissions beyond the policy.${exists(HOUSE_RULES_FILE) ? ` You have one now (${tilde(HOUSE_RULES_FILE)}).` : ''}`);
    for (;;) {
      const p = await io.ask(`  A file to use${exists(HOUSE_RULES_FILE) ? ', "none" to remove yours,' : ''} or Enter to ${exists(HOUSE_RULES_FILE) ? 'keep yours' : 'skip'}:`);
      if (!p) break;
      if (p.toLowerCase() === 'none') {
        houseRules = '';
        break;
      }
      if (isFile(abs(p))) {
        houseRules = fs.readFileSync(abs(p), 'utf8');
        break;
      }
      console.log('  Not a file.');
    }

    return { answers: { claudeBin, groupName, agents, preset: policy.preset || 'newcomer', policy, acceptPolicy: true, houseRules }, io };
  } catch (e) {
    io.close();
    throw e;
  }
}

function loadAnswers(arg) {
  const text = arg.trim().startsWith('{') ? arg : fs.readFileSync(abs(arg), 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`--answers isn't valid JSON (${e.message})`);
  }
}

// ---------- commands ----------

async function setup(opts) {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`council-board needs Node 20 or newer (this is ${process.versions.node}).`);

  let answers;
  let io = null;
  if (opts.answers) answers = loadAnswers(opts.answers);
  else {
    if (!process.stdin.isTTY) throw new Error('Not a terminal. For a scripted setup use --answers <file> --yes (see docs/setup.md).');
    ({ answers, io } = await interview(opts));
  }
  try {
    const result = normalizeAnswers(answers);
    if (!result.acceptPolicy) throw new Error('The policy must be accepted explicitly: add "acceptPolicy": true to the answers after reading docs/policies.md.');
    const claudeBin = findClaudeBin(opts.claudeBin || result.claudeBin);
    if (!claudeBin && !opts.dryRun) throw new Error("Can't find the Claude Code CLI (`claude`). Install it or pass --claude-bin <path>.");
    if (opts.answers) console.log(`Policy (accepted in the answers):\n${describePolicy(result.policy)}`);
    const plan = buildPlan(result, claudeBin);
    printPlan(plan);
    if (opts.dryRun) {
      console.log('\nDry run: nothing was written.');
      return 0;
    }
    if (!opts.yes) {
      if (!io) throw new Error('Add --yes to apply a scripted setup.');
      if (!(await io.yesNo('\nApply this plan?', false))) {
        console.log('Stopped; nothing was written.');
        return 1;
      }
    }
    console.log('');
    applyPlan(plan);
    console.log(`\nWritten. Config: ${tilde(CONFIG_DIR)}. Undo with: node ${shq(tilde(path.join(REPO, 'setup.mjs')))} uninstall`);
    let ok = true;
    for (const a of plan.accounts) {
      const r = await smokeTest(a.agent);
      console.log(r.ok ? `  ✓ the board answers as "${a.agent.name}" (${r.tools} tools)` : `  ✗ smoke test for "${a.agent.name}": ${r.problem}`);
      ok &&= r.ok;
    }
    console.log('\nStart new Claude Code sessions (or restart open ones) to pick it up. Try /help-out and /get-help.\nCheck it any time with: node setup.mjs doctor');
    return ok ? 0 : 1;
  } finally {
    io?.close();
  }
}

async function doctor(opts) {
  let problems = 0;
  const ok = (m) => console.log(`  ✓ ${m}`);
  const bad = (m) => (problems++, console.log(`  ✗ ${m}`));
  const warn = (m) => console.log(`  ! ${m}`);

  console.log('council-board doctor');
  const major = Number(process.versions.node.split('.')[0]);
  major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} is too old (20 or newer)`);
  console.log(`  config: ${tilde(CONFIG_DIR)}\n  data:   ${tilde(DATA_DIR)}`);

  let agentsConfig = null;
  try {
    agentsConfig = loadAgents({ fresh: true });
    agentsConfig ? ok(`agents.json: ${agentsConfig.agents.map((a) => `${a.name} (${a.kind})`).join(', ')}`) : bad('no agents.json yet: run node setup.mjs');
  } catch (e) {
    bad(e.message);
  }
  let policy = null;
  try {
    const saved = readJson(POLICY_FILE, null);
    if (!saved) bad('no policy.json yet: run node setup.mjs (until then the newcomer preset applies)');
    policy = merge(NEWCOMER, saved || {});
    const p = validatePolicy(policy);
    if (p.length) bad(`policy.json: ${p.join('; ')}`), (policy = null);
    else if (saved) ok(`policy.json (preset "${policy.preset}")`);
  } catch (e) {
    bad(e.message);
  }
  if (exists(HOUSE_RULES_FILE)) ok(`house rules: ${tilde(HOUSE_RULES_FILE)}`);
  const manifest = readJson(MANIFEST_FILE, null);
  if (manifest && manifest.repo !== REPO) warn(`setup last ran from ${tilde(manifest.repo)}, not from this copy (${tilde(REPO)})`);

  const claudeBin = findClaudeBin(opts.claudeBin);
  claudeBin ? ok(`Claude Code CLI: ${tilde(claudeBin)}`) : warn("Claude Code CLI not found (only setup and uninstall need it; pass --claude-bin if it's elsewhere)");

  const codex = agentsConfig?.agents.find((a) => a.kind === 'codex');
  if (codex && policy?.codex.enabled) {
    let bin = null;
    try {
      bin = findCodexBin();
    } catch {}
    bin ? ok(`Codex CLI: ${tilde(bin)}`) : bad(`Codex CLI not found for "${codex.name}" (set "bin" in agents.json or CODEX_BIN)`);
  }

  if (agentsConfig && policy) {
    const commands = renderCommands(agentsConfig, policy);
    for (const agent of agentsConfig.agents.filter((a) => a.kind === 'claude-code')) {
      const dir = abs(agent.configDir);
      console.log(`\n${agent.name} (${tilde(dir)})`);
      if (!exists(dir)) {
        bad("the folder doesn't exist");
        continue;
      }
      try {
        const server = boardServer(dir);
        if (!server) bad('MCP server "board" not added: run setup again');
        else if (!server.ours) bad(`MCP server "board" points elsewhere: ${[server.command, ...(server.args || [])].join(' ')}`);
        else if (server.env?.BOARD_AGENT !== agent.id) bad(`MCP server "board" speaks for "${server.env?.BOARD_AGENT || '?'}", not "${agent.id}"`);
        else ok('MCP server "board"');
      } catch (e) {
        bad(e.message);
      }
      try {
        const settings = readJson(path.join(dir, 'settings.json'), {});
        const want = hookCommand(agent.id);
        const missing = HOOK_EVENTS.filter(({ event, matcher }) => !(settings.hooks?.[event] || []).some((e) => (e.matcher || undefined) === matcher && e.hooks?.some((h) => h.command === want)));
        missing.length ? bad(`hooks missing or outdated: ${missing.map((h) => h.event).join(', ')}`) : ok('hooks');
        (settings.permissions?.allow || []).includes(ALLOW_RULE) ? ok(`"${ALLOW_RULE}" allowed`) : warn(`"${ALLOW_RULE}" isn't in permissions.allow, so each board tool will ask first`);
        const deny = (settings.permissions?.deny || []).filter((r) => r.startsWith(ALLOW_RULE));
        if (deny.length) warn(`denied in settings.json: ${deny.join(', ')}`);
      } catch (e) {
        bad(e.message);
      }
      for (const c of COMMANDS) {
        const file = path.join(dir, 'commands', `${c}.md`);
        if (!commands[c]) {
          if (isOurs(file)) warn(`/${c} is still installed but the policy turned it off: run setup again`);
          continue;
        }
        if (!exists(file)) bad(`/${c} missing`);
        else if (!isOurs(file)) warn(`/${c} is your own file, not the board's`);
        else if (fs.readFileSync(file, 'utf8') !== commands[c]) bad(`/${c} is outdated: run setup again`);
        else ok(`/${c}`);
      }
      const r = await smokeTest(agent);
      r.ok ? ok(`the board answers as "${agent.name}" (${r.tools} tools)`) : bad(`smoke test: ${r.problem}`);
    }
    console.log(`\nPolicy in force:\n${describePolicy(policy)}`);
  }
  console.log(problems ? `\n${problems} problem${problems > 1 ? 's' : ''} found.` : '\nAll good.');
  return problems ? 1 : 0;
}

async function uninstall(opts) {
  const manifest = readJson(MANIFEST_FILE, null);
  if (!manifest) {
    console.log(`Nothing to undo: there is no ${tilde(MANIFEST_FILE)}.`);
    return 0;
  }
  const lines = ['Uninstall will:'];
  for (const a of manifest.accounts || []) {
    lines.push(`  ${tilde(a.configDir)}: remove the board's hooks${a.addedAllow ? ` and the "${ALLOW_RULE}" allow rule` : ''}, its commands (${(a.commands || []).map((f) => '/' + path.basename(f, '.md')).join(', ') || 'none'}) and its MCP server "board"`);
  }
  lines.push(opts.purge ? `  delete agents.json, policy.json, house-rules.md and the manifest in ${tilde(CONFIG_DIR)}` : `  delete the manifest, and keep agents.json and policy.json (add --purge to delete them)`);
  lines.push(`  keep the board's messages and records (${tilde(DATA_DIR)}) and the backups (${tilde(path.join(CONFIG_DIR, 'backups'))}); delete them yourself if you want them gone`);
  console.log(lines.join('\n'));
  if (opts.dryRun) {
    console.log('\nDry run: nothing was changed.');
    return 0;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) throw new Error('Add --yes to uninstall without a terminal.');
    const io = makeAsker();
    const go = await io.yesNo('\nGo ahead?', false);
    io.close();
    if (!go) return 1;
  }
  const { backup, copies, dir } = makeBackup(`${new Date().toISOString().replace(/[:.]/g, '-')}-uninstall`);
  const claudeBin = findClaudeBin(opts.claudeBin);
  for (const a of manifest.accounts || []) {
    console.log(`Removing the board from ${tilde(a.configDir)}`);
    unwireAccount(a, claudeBin, backup);
  }
  if (opts.purge) {
    for (const f of [AGENTS_FILE, POLICY_FILE, HOUSE_RULES_FILE]) {
      backup(f);
      fs.rmSync(f, { force: true });
    }
  }
  fs.rmSync(MANIFEST_FILE, { force: true });
  console.log(`Done.${copies.length ? ` Backups of the changed files: ${tilde(dir)}.` : ''} Restart open Claude Code sessions.`);
  return 0;
}

const HELP = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).map((l) => l.replace(/^\/\/ ?/, '')).join('\n');

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.cmd === 'help') return console.log(HELP), 0;
  if (opts.cmd === 'doctor') return doctor(opts);
  if (opts.cmd === 'uninstall') return uninstall(opts);
  return setup(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code || 0),
    (error) => {
      console.error(`\n${error.message}`);
      process.exit(1);
    },
  );
}
