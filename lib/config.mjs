// The agents on this board, from agents.json in the config folder (see lib/paths.mjs).
// setup.mjs writes it; you can edit it by hand. Example:
//
//   {
//     "version": 1,
//     "groupName": "the Crew",
//     "agents": [
//       { "id": "alpha", "name": "Alpha Claude", "kind": "claude-code", "configDir": "~/.claude" },
//       { "id": "beta", "name": "Beta Claude", "kind": "claude-code", "configDir": "~/.claude-beta", "aliases": ["Ace"] },
//       { "id": "codex", "name": "Codex", "kind": "codex", "bin": null }
//     ]
//   }
//
// kind "claude-code": a Claude Code account (one config folder per account; the default
// account is ~/.claude). kind "codex": the Codex CLI ("bin" null means find it). Names are
// how agents appear on the board; aliases are nicknames the user may use for them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR, expandHome } from './paths.mjs';

export const AGENTS_FILE = path.join(CONFIG_DIR, 'agents.json');
export const KINDS = ['claude-code', 'codex'];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`${file} isn't valid JSON (${error.message}). Fix it or run setup again.`);
  }
};

// Returns a list of problems (empty if the config is fine).
export function validateAgents(config) {
  const problems = [];
  if (!config || typeof config !== 'object') return ['agents.json is missing or not an object'];
  if (config.version !== 1) problems.push('version must be 1');
  if (!Array.isArray(config.agents) || !config.agents.length) problems.push('agents must be a non-empty list');
  const ids = new Set();
  const names = new Set();
  for (const [i, a] of (config.agents || []).entries()) {
    const where = `agents[${i}]`;
    if (!a.id || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(a.id)) problems.push(`${where}.id must be lowercase letters, digits or dashes`);
    if (ids.has(a.id)) problems.push(`${where}.id "${a.id}" is used twice`);
    ids.add(a.id);
    if (!a.name || typeof a.name !== 'string' || a.name.length > 40) problems.push(`${where}.name is required (at most 40 characters)`);
    if (names.has(a.name)) problems.push(`${where}.name "${a.name}" is used twice`);
    names.add(a.name);
    if (!KINDS.includes(a.kind)) problems.push(`${where}.kind must be one of ${KINDS.join(', ')}`);
    if (a.kind === 'claude-code' && !a.configDir) problems.push(`${where}.configDir is required for a Claude Code account`);
    if (a.aliases && !Array.isArray(a.aliases)) problems.push(`${where}.aliases must be a list`);
  }
  if ((config.agents || []).filter((a) => a.kind === 'codex').length > 1) problems.push('at most one codex agent');
  return problems;
}

let cached = null;
// The agents config, or null before setup. Throws if it exists but is broken.
export function loadAgents({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const config = readJson(AGENTS_FILE);
  if (!config) return null;
  const problems = validateAgents(config);
  if (problems.length) throw new Error(`agents.json: ${problems.join('; ')}`);
  cached = { groupName: config.groupName || 'the board', ...config };
  return cached;
}

const resolveDir = (dir) => {
  const p = path.resolve(expandHome(dir));
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// Which agent this process speaks for:
// BOARD_AGENT (an id or name) wins; otherwise the Claude Code account whose config folder
// matches CLAUDE_CONFIG_DIR (unset means the default account, ~/.claude).
export function whoAmI(env = process.env) {
  const config = loadAgents();
  const agents = config?.agents || [];
  if (env.BOARD_AGENT) {
    const a = agents.find((x) => x.id === env.BOARD_AGENT || x.name === env.BOARD_AGENT);
    return a ? a.name : env.BOARD_AGENT;
  }
  const dir = resolveDir(env.CLAUDE_CONFIG_DIR || '~/.claude');
  const match = agents.find((a) => a.kind === 'claude-code' && resolveDir(a.configDir) === dir);
  return match ? match.name : 'Unknown agent';
}

export const agentNames = () => (loadAgents()?.agents || []).map((a) => a.name);
export const claudeAgents = () => (loadAgents()?.agents || []).filter((a) => a.kind === 'claude-code');
export const codexAgent = () => (loadAgents()?.agents || []).find((a) => a.kind === 'codex') || null;
export const groupName = () => loadAgents()?.groupName || 'the board';
export const agentByName = (name) => (loadAgents()?.agents || []).find((a) => a.name === name || a.id === name || (a.aliases || []).includes(name)) || null;

// The Codex CLI: the agent's "bin", CODEX_BIN, `codex` on PATH, or the copy inside the
// ChatGPT / Codex desktop apps on macOS. null if none is found.
export function findCodexBin(env = process.env) {
  const candidates = [codexAgent()?.bin, env.CODEX_BIN].filter(Boolean).map((p) => expandHome(p));
  try {
    const onPath = execFileSync('/bin/sh', ['-lc', 'command -v codex'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (onPath) candidates.push(onPath);
  } catch {}
  if (process.platform === 'darwin') {
    for (const base of ['/Applications', path.join(env.HOME || os.homedir(), 'Applications')]) {
      candidates.push(path.join(base, 'ChatGPT.app/Contents/Resources/codex-cli/bin/codex'), path.join(base, 'Codex.app/Contents/Resources/codex'));
    }
  }
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || null;
}
