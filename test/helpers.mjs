import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = fileURLToPath(new URL('../', import.meta.url));
export const moduleURL = (file) => pathToFileURL(path.join(REPO, file)).href;
export const FAKE_CODEX = path.join(REPO, 'test/fixtures/fake-codex');

export const agentsConfig = () => ({
  version: 1,
  groupName: 'the Test Council',
  agents: [
    { id: 'alpha', name: 'Alpha Claude', kind: 'claude-code', configDir: '~/.claude' },
    { id: 'beta', name: 'Beta Claude', kind: 'claude-code', configDir: '~/.claude-beta', aliases: ['Ace'] },
    { id: 'codex', name: 'Codex', kind: 'codex', bin: null },
  ],
});

// Parent test processes never import board modules. Every scenario gets a child with
// fresh HOME/BOARD_HOME and an allowlisted environment, without real account settings.
export function sandbox(t, { policy, agents = agentsConfig() } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  const board = fs.mkdtempSync(path.join(root, 'board-'));
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  const tmp = fs.mkdtempSync(path.join(root, 'tmp-'));
  const env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`,
    HOME: home, BOARD_HOME: board, BOARD_AGENT: 'alpha',
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    CODEX_HOME: path.join(home, '.codex'), CODEX_BIN: FAKE_CODEX,
    CLAUDE_PROJECT_DIR: project, TEST_ROOT: root,
    TMPDIR: tmp, TMP: tmp, TEMP: tmp, TZ: 'UTC', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'empty-gitconfig'),
    GIT_CEILING_DIRECTORIES: root,
    FAKE_CODEX_CALLS: path.join(root, 'codex-calls.jsonl'),
  };
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  const json = (file, value) => write(file, JSON.stringify(value));
  if (agents) json(path.join(board, 'agents.json'), agents);
  if (policy) json(path.join(board, 'policy.json'), policy);
  function node(argv, options = {}) {
    return spawnSync(process.execPath, argv, {
      encoding: 'utf8', cwd: project, timeout: 8000, maxBuffer: 2 * 1024 * 1024,
      ...options, env: { ...env, ...options.env },
    });
  }
  const run = (file, argv = [], options) => node([path.join(REPO, file), ...argv], options);
  const evaluate = (body, options) => node(['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    ${body}
  `], options);
  return { root, home, board, project, tmp, env, write, json, node, run, evaluate };
}

export function succeeds(result) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

export function refuses(result, message) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 1, result.stdout || result.stderr);
  assert.match(result.stderr, message);
}

// Emulates only read-only Git queries. No test initializes, adds or commits a repo.
export function fakeGit(s, { changed = [], tracked = [], diff = '' } = {}) {
  const bin = path.join(s.root, 'bin');
  const file = s.write(path.join(bin, 'git'), `#!/usr/bin/env node
    const args = process.argv.slice(2);
    const has = (flag) => args.includes(flag);
    if (has('rev-parse')) {
      if (has('--show-toplevel')) console.log(process.env.FAKE_GIT_ROOT);
      else if (has('--git-common-dir')) console.log(process.env.FAKE_GIT_ROOT + '/.git');
      else if (has('--verify')) console.log('0'.repeat(40));
      else process.exit(2);
    } else if (has('ls-files')) {
      if (!has('-o')) process.stdout.write(JSON.parse(process.env.FAKE_GIT_TRACKED).join('\\0') + '\\0');
    } else if (has('diff')) {
      if (has('--name-only')) process.stdout.write(JSON.parse(process.env.FAKE_GIT_CHANGED).join('\\0'));
      else process.stdout.write(process.env.FAKE_GIT_DIFF);
    } else process.exit(2);
  `);
  fs.chmodSync(file, 0o755);
  Object.assign(s.env, {
    PATH: `${bin}${path.delimiter}${s.env.PATH}`, FAKE_GIT_ROOT: s.project,
    FAKE_GIT_CHANGED: JSON.stringify(changed), FAKE_GIT_TRACKED: JSON.stringify(tracked),
    FAKE_GIT_DIFF: diff,
  });
}

export function startServer(s, { agent = 'alpha' } = {}) {
  const child = spawn(process.execPath, [path.join(REPO, 'server.mjs')], {
    cwd: s.project, env: { ...s.env, BOARD_AGENT: agent }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let nextId = 0;
  const pending = new Map();
  child.stderr.on('data', (data) => { stderr += data; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let reply;
    try { reply = JSON.parse(line); } catch { return; }
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    request.resolve(reply);
  });
  const rejectAll = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on('error', rejectAll);
  const closed = new Promise((resolve) => child.on('close', (code) => {
    rejectAll(new Error(`Server exited ${code}: ${stderr}`));
    resolve();
  }));
  return {
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          child.kill('SIGKILL');
          reject(new Error(`Timed out waiting for ${method}: ${stderr}`));
        }, 5000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async close() {
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.stdin.end();
      try { await closed; } finally { clearTimeout(timer); lines.close(); }
      assert.equal(stderr, '');
    },
  };
}
