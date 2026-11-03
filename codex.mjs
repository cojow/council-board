#!/usr/bin/env node
// Runs Codex (the user's ChatGPT/Codex account, through the Codex CLI that comes with
// the ChatGPT app) as a third worker on the message board, started by a Claude acting on
// the user's request. Nothing here starts Codex by itself.
//
// - Read-only by default: Codex works in the project folder but can't change anything.
// - With --write it works in its own copy: a git worktree on a new codex/<slug> branch,
//   made from a snapshot of the project including uncommitted and untracked files (big
//   files left out), so it can't touch files you or a Claude are editing. When it stops,
//   its changes are committed on that branch ("incomplete" if it failed or timed out).
// - Nothing reaches the project until `apply`, which a Claude runs only after the user
//   says yes; conflicts are reported, not forced.
// - Network is off unless --network (or the policy turns it on). Runs stop after the policy's
//   time limit; at most the policy's number run at once.
// - The user's answer for each project ("may Codex read this project's code?": on /
//   review-only / off) is kept here, outside the project, and enforced; "Codex: off" in a
//   project's CLAUDE.md also works. After a usage or rate limit, runs the Claudes start by
//   themselves (--auto) pause until the next day. See docs/policies.md.
// - The launcher posts for Codex on the board (started, progress, finished); Codex itself
//   gets no board tools. Every run is recorded in runs/<id>.json.
//
// Usage:
//   node codex.mjs run --project <dir> (--task "<text>" | --task-file <file>) [--write | --review] [--network]
//                      [--auto] [--dry-run] [--base <git ref>] [--context <file,file,…>]
//                      [--title "<short name>"] [--from "<agent name>"] [--model <m>] [--effort <e>]
//        --review   Codex sees only a review sandbox: the changes (since --base, default HEAD,
//                   uncommitted included), the changed code files and the --context files, never
//                   data files (name and size only) or files that look like credentials.
//        --auto     the Claude is bringing Codex in by itself (paused for the day after a usage limit).
//        --dry-run  show what Codex would see, without running it.
//   node codex.mjs consent <project> [on|review-only|off]   the user's answer for a project (or show it)
//   node codex.mjs resume <run> (--task "<text>" | --task-file <file>)    follow-up in the same Codex conversation
//   node codex.mjs show <run>      what changed (stat and diff) and Codex's last message
//   node codex.mjs apply <run>     put an editing run's changes into the project (after the user says yes)
//   node codex.mjs list            recent runs
//   node codex.mjs cleanup         remove copies of applied runs and of runs older than 14 days (branches stay)
//   node codex.mjs finish <run>    wrap up a run whose launcher died (commit what's there, report it)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { append, BOARD_DIR, projectKey, selfLevel, whoAmI } from './board.mjs';
import { claudeAgents, codexAgent, findCodexBin, groupName } from './lib/config.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { codexMatch, label } from './models.mjs';

const HOME = path.join(BOARD_DIR, 'codex');
const RUNS = path.join(HOME, 'runs'); // one <id>.json per run, so two runs never overwrite each other's record
const CLAUDES = () => claudeAgents().map((a) => a.name);
const CODEX = () => codexAgent()?.name || 'Codex';
const policy = () => loadPolicy().codex;
const PROJECTS = path.join(HOME, 'projects.json'); // per-project answers: { [projectKey]: { answer, at, by } }
const PAUSE = path.join(HOME, 'paused.json'); // { day: 'YYYY-MM-DD', reason } after a usage limit
const REVIEWS = path.join(HOME, 'review'); // review sandboxes, one folder per run
const ANSWERS = ['on', 'review-only', 'off'];
// Review sandbox contents: code and text files only, small; data files appear as a name and size.
const CODE_EXT = new Set(['.py', '.r', '.ipynb', '.m', '.jl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.c', '.h', '.cpp', '.hpp', '.cc', '.rs', '.go', '.rb', '.sh', '.zsh', '.bash', '.sql', '.swift', '.kt', '.f', '.f90', '.f95', '.tex', '.bib', '.md', '.rst', '.qmd', '.rmd', '.toml', '.cfg', '.ini', '.html', '.css', '.scss', '.mk', '.cmake']);
const SMALL_TEXT_EXT = new Set(['.json', '.txt', '.yaml', '.yml', '.xml']); // often config, sometimes data: only when small
const CODE_NAMES = new Set(['makefile', 'dockerfile', 'requirements.txt', 'pyproject.toml', 'setup.cfg', 'environment.yml', 'package.json', 'readme']);
const MAX_CODE_FILE = 1024 * 1024;
const MAX_SMALL_TEXT = 200 * 1024;
const SECRET_NAME = /(^|\/)\.env(\.|$)|\.(pem|key|p12|pfx|keystore|jks)$|(^|\/)id_(rsa|dsa|ecdsa|ed25519)|credential|secret|token/i;
const SECRET_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|(api[_-]?key|secret|passw(or)?d|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i;
const LIMIT_TEXT = /rate.?limit|usage limit|quota|too many requests|\b429\b|reached your .{0,40}limit/i;
const timeoutMs = () => policy().timeoutMinutes * 60 * 1000;
const PROGRESS_MS = 5 * 60 * 1000;
const maxRunning = () => policy().maxConcurrent;
const MAX_SNAPSHOT_FILE = 50 * 1024 * 1024;
const KEEP_DAYS = 14;

// ---------- small helpers ----------

const die = (message) => {
  console.error(`codex.mjs: ${message}`);
  process.exit(1);
};
const git = (cwd, args, options = {}) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options }).trim();
const slugify = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (['--write', '--network', '--review', '--auto', '--dry-run', '--quiet'].includes(a)) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

function readRuns() {
  let names = [];
  try {
    names = fs.readdirSync(RUNS).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const runs = [];
  for (const name of names) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(RUNS, name), 'utf8')));
    } catch {}
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt);
}

// Each run's record is its own file (temp file and rename, so a crash never leaves half a file).
function saveRun(run) {
  fs.mkdirSync(RUNS, { recursive: true });
  const file = path.join(RUNS, `${run.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// A run whose launcher is gone (its session ended, a crash) but that was never finished.
const stale = (run) => run.status === 'running' && !(run.launcherPid && alive(run.launcherPid));

function findRun(id) {
  const run = readRuns().find((r) => r.id === id || r.id.startsWith(id));
  if (!run) die(`no run ${id} (see: node codex.mjs list)`);
  return run;
}

// The Codex CLI ships inside the ChatGPT app and moves with its updates: find it, and
// check it still has what this launcher uses.
function codexBin() {
  const bin = findCodexBin();
  if (!bin) die('Codex CLI not found. Install it (or the ChatGPT desktop app, which includes it), set "bin" for the codex agent in agents.json, or set CODEX_BIN.');
  let help = '';
  try {
    help = execFileSync(bin, ['exec', '--help'], { encoding: 'utf8', timeout: 15000 });
  } catch (error) {
    die(`Codex CLI at ${bin} didn't run: ${error.message}`);
  }
  for (const flag of ['--json', '--output-last-message', '--sandbox', '--cd']) if (!help.includes(flag)) die(`this Codex CLI (${bin}) has no ${flag}; the launcher needs updating.`);
  return bin;
}

function taskText(opts) {
  if (opts['task-file']) return fs.readFileSync(opts['task-file'], 'utf8').trim();
  if (opts.task) return String(opts.task).trim();
  die('give the task with --task "<text>" or --task-file <file>');
}

// Codex's posts go to the Claude that started it (to everyone if that isn't a known name).
// --quiet (debate turns): no posts, since a sealed view must not appear on the board in the open.
const post = (run, fields) => (run.quiet && !fields.everywhere ? null : append({ from: CODEX(), project: run.project, ...(CLAUDES().includes(run.from) ? { to: run.from } : {}), ...fields }));

// ---------- the user's answers, and the daily pause ----------

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
};
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local

// The user's answer for a project: "Codex: off" in its CLAUDE.md wins; otherwise the
// answer recorded with `consent`; null if never asked.
function consentFor(folder, root) {
  for (const dir of [...new Set([folder, root].filter(Boolean))]) {
    for (const file of [path.join(dir, 'CLAUDE.md'), path.join(dir, '.claude', 'CLAUDE.md')]) {
      try {
        if (/^\s*[-*]?\s*Codex:\s*off\b/im.test(fs.readFileSync(file, 'utf8'))) return { answer: 'off', source: path.relative(dir, file) };
      } catch {}
    }
  }
  const saved = readJson(PROJECTS, {})[projectKey(folder)];
  return saved ? { ...saved, source: 'recorded' } : null;
}

// Records the user's answer. A Claude runs this only after the user answered in the conversation.
function consentCommand(opts) {
  const target = opts._[1] || die('which project folder?');
  const folder = path.resolve(target.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(folder)) die(`no such folder: ${folder}`);
  const key = projectKey(folder);
  const answer = opts._[2];
  if (!answer) {
    const now = consentFor(folder, null);
    return console.log(now ? `Codex for ${key}: ${now.answer} (${now.source}${now.at ? `, ${new Date(now.at).toLocaleString()}` : ''})` : `Codex for ${key}: not asked yet.`);
  }
  if (!ANSWERS.includes(answer)) die(`the answer is one of: ${ANSWERS.join(', ')}`);
  const all = readJson(PROJECTS, {});
  all[key] = { answer, at: Date.now(), by: opts.from || whoAmI() };
  writeJson(PROJECTS, all);
  console.log(`Recorded: Codex is ${answer} for ${key}.`);
}

const pausedToday = () => {
  const p = readJson(PAUSE, null);
  return p && p.day === today() ? p : null;
};

// ---------- review sandbox ----------

const kindOf = (file, size) => {
  const base = path.basename(file).toLowerCase();
  const ext = path.extname(base);
  if (SECRET_NAME.test(file)) return 'withheld';
  if (CODE_NAMES.has(base)) return size <= MAX_CODE_FILE ? 'code' : 'data';
  if (CODE_EXT.has(ext)) return size <= MAX_CODE_FILE ? 'code' : 'data';
  if (SMALL_TEXT_EXT.has(ext)) return size <= MAX_SMALL_TEXT ? 'code' : 'data';
  return 'data';
};

const statLine = (full, rel, size) => {
  let rows = '';
  if (/\.(csv|tsv)$/i.test(rel) && size <= 50 * 1024 * 1024) {
    try {
      rows = `, ${fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).length} lines`;
    } catch {}
  }
  return `${rel}: ${size} bytes${rows}`;
};

// Builds the folder Codex sees for a review: CHANGES.diff, the changed code files, the
// --context files, DATA_FILES.txt (names and sizes only) and WITHHELD.txt.
function buildReview(root, folder, opts, dir) {
  const realRoot = fs.realpathSync(root);
  const within = (base, file) => {
    const rel = path.relative(base, file);
    return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  };
  const base = opts.base || 'HEAD';
  try {
    git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    die(`--review compares against ${base}, which isn't a commit here (commit once, or pass --base).`);
  }
  const changed = new Set([
    ...git(root, ['diff', '--name-only', '-z', base]).split('\0').filter(Boolean),
    ...git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean),
  ]);
  const context = String(opts.context || '').split(',').map((f) => f.trim()).filter(Boolean).map((f) => path.relative(root, path.resolve(folder, f)));
  const manifest = { code: [], data: [], withheld: [], missing: [] };
  const take = (rel, role) => {
    const full = path.resolve(root, rel);
    if (!within(root, full)) throw new Error(`review file is outside the project: ${rel}`);
    let size;
    let real;
    try {
      real = fs.realpathSync(full);
      size = fs.statSync(full).size;
    } catch {
      if (role === 'context') manifest.missing.push(rel);
      return; // deleted: the diff shows it
    }
    if (!within(realRoot, real)) throw new Error(`review file resolves outside the project: ${rel}`);
    let kind = kindOf(rel, size);
    if (kind === 'code' && SECRET_TEXT.test(fs.readFileSync(full, 'utf8'))) kind = 'withheld';
    if (kind === 'code') {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.copyFileSync(full, path.join(dir, rel));
      manifest.code.push(`${rel}${role === 'context' ? ' (context)' : ''}`);
    } else if (kind === 'data') manifest.data.push(statLine(full, rel, size));
    else manifest.withheld.push(rel);
  };
  for (const rel of changed) take(rel, 'changed');
  for (const rel of context) if (!changed.has(rel)) take(rel, 'context');
  // The diff covers only the code files that made it in; new code files are copied whole.
  const inDiff = [...changed].filter((rel) => manifest.code.includes(rel) || (!fs.existsSync(path.join(root, rel)) && kindOf(rel, 0) === 'code'));
  const diff = inDiff.length ? git(root, ['diff', base, '--', ...inDiff]) : '';
  if (SECRET_TEXT.test(diff)) throw new Error('review diff may contain credentials (including removed lines); choose a base without sensitive changes before sending it');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CHANGES.diff'), diff ? `${diff}\n` : '(no changes to code files; new files are included as they are)\n');
  if (manifest.data.length) fs.writeFileSync(path.join(dir, 'DATA_FILES.txt'), `Data files that changed (contents not included):\n${manifest.data.join('\n')}\n`);
  if (manifest.withheld.length) fs.writeFileSync(path.join(dir, 'WITHHELD.txt'), `Left out because they may hold credentials:\n${manifest.withheld.join('\n')}\n`);
  return { ...manifest, base };
}

const manifestText = (m) =>
  [
    `Changes since ${m.base}.`,
    `Code files Codex sees (${m.code.length}): ${m.code.join(', ') || 'none'}`,
    m.data.length ? `Data files, name and size only (${m.data.length}): ${m.data.join('; ')}` : null,
    m.withheld.length ? `Withheld, may hold credentials (${m.withheld.length}): ${m.withheld.join(', ')}` : null,
    m.missing.length ? `Context files not found: ${m.missing.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

// ---------- snapshot and worktree ----------

// One commit holding the project as it is now (tracked, untracked, uncommitted), made
// with a temporary index so your index and files are untouched. Big untracked files are
// left out and listed.
function snapshot(root) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-index-'));
  const tmpIndex = path.join(tmpDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  const skipped = [];
  try {
    git(root, ['read-tree', 'HEAD'], { env });
    git(root, ['add', '-u'], { env });
    const untracked = git(root, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    const keep = [];
    for (const file of untracked) {
      try {
        if (fs.statSync(path.join(root, file)).size > MAX_SNAPSHOT_FILE) skipped.push(file);
        else keep.push(file);
      } catch {}
    }
    for (let i = 0; i < keep.length; i += 200) git(root, ['add', '--', ...keep.slice(i, i + 200)], { env });
    const tree = git(root, ['write-tree'], { env });
    const commit = git(root, ['commit-tree', tree, '-p', 'HEAD', '-m', 'Snapshot for Codex (your folder as it was, uncommitted changes included)']);
    return { commit, skipped };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function makeWorktree(root, title) {
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
  let slug = `${slugify(title)}-${stamp}`;
  const base = path.join(HOME, path.basename(root));
  const taken = (s) => fs.existsSync(path.join(base, s)) || (() => {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/codex/${s}`]);
      return true;
    } catch {
      return false;
    }
  })();
  for (let n = 2; taken(slug); n++) slug = `${slugify(title)}-${stamp}-${n}`;
  const { commit, skipped } = snapshot(root);
  const dir = path.join(base, slug);
  fs.mkdirSync(base, { recursive: true });
  git(root, ['worktree', 'add', '-q', '-b', `codex/${slug}`, dir, commit]);
  return { dir, branch: `codex/${slug}`, snapshot: commit, skipped };
}

// Commits whatever Codex changed in its copy, so nothing is lost even if it stopped early.
function commitResult(run, reason) {
  // Big new files (generated data that isn't gitignored) stay out of the commit, as in the snapshot.
  const big = git(run.worktree, ['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter((f) => {
    try {
      return f && fs.statSync(path.join(run.worktree, f)).size > MAX_SNAPSHOT_FILE;
    } catch {
      return false;
    }
  });
  run.leftOut = big;
  git(run.worktree, ['add', '-A', '--', '.', ...big.map((f) => `:(exclude)${f}`)]);
  if (!git(run.worktree, ['diff', '--cached', '--name-only'])) return null;
  const title = `codex: ${run.title}${reason ? ` (incomplete: ${reason})` : ''}`;
  git(run.worktree, ['-c', 'user.name=Codex', '-c', 'user.email=codex@localhost', 'commit', '-q', '-m', title, '-m', `Requested by ${run.from} through the message board.\n\nCo-authored-by: Codex <codex@localhost>`]);
  return git(run.worktree, ['rev-parse', 'HEAD']);
}

// ---------- running Codex ----------

function prompt(run, task) {
  const where = run.review
    ? "This is a review sandbox, not the whole project: CHANGES.diff holds the changes, and the folder holds the changed code files plus some supporting context. Data files are listed in DATA_FILES.txt by name and size only, and files that may hold credentials were left out (WITHHELD.txt). You can't change anything. Report prioritized findings with file:line locations and the evidence for each. If the context here isn't enough to judge something, say so plainly instead of guessing."
    : run.write
    ? `You're working in your own copy of the project (git branch ${run.branch}), made just for this task. Edit files there freely; nothing you do touches the user's folder until they approve it. Don't run git commands that write (add, commit, checkout, branch); the launcher commits your work when you finish.`
    : "You can read the project but not change anything (read-only). Answer, analyse or review; don't try to edit files.";
  return [
    `You are ${CODEX()} (Codex), working for ${run.from} (a Claude assistant) on the user's request, through a shared message board. You and ${CLAUDES().join(' and ') || 'the Claude agents'} are the user's AI agents, which the user calls ${groupName()}.`,
    `Your final message goes back to ${run.from}, who will review your work before the user sees it.`,
    where,
    run.network ? 'Network access is on.' : "Network access is off: don't try to install packages or fetch anything from the internet; if the task needs that, say so.",
    'When you finish, reply with: what you did (files changed), how you checked it, and anything left undone. If you get stuck on a question only the user or the requesting Claude can answer, end with a line starting "BLOCKED:" and the question.',
    '',
    'TASK:',
    task,
  ].join('\n');
}

function codexArgs(run, { resume, task }) {
  const common = ['--json', '-o', run.lastFile, '-c', `sandbox_mode="${run.write ? 'workspace-write' : 'read-only'}"`];
  common.push('-c', `sandbox_workspace_write.network_access=${Boolean(run.network)}`);
  if (run.model) common.push('-m', run.model);
  if (run.effort) common.push('-c', `model_reasoning_effort="${run.effort}"`);
  if (!run.git) common.push('--skip-git-repo-check');
  if (resume) return ['exec', 'resume', ...common, '--', run.thread, task];
  return ['exec', '-C', run.dir, '-s', run.write ? 'workspace-write' : 'read-only', ...common, prompt(run, task)];
}

async function execute(run, codexArgsList) {
  const bin = codexBin();
  const log = fs.openSync(run.logFile, 'a');
  const errLog = fs.openSync(run.logFile.replace(/\.jsonl$/, '.err'), 'a');
  const child = spawn(bin, codexArgsList, { cwd: run.dir, stdio: ['ignore', 'pipe', errLog] });
  run.status = 'running';
  run.pid = child.pid;
  run.launcherPid = process.pid;
  saveRun(run);
  // If the launcher is told to stop (its session ended, Ctrl-C), stop Codex and still
  // commit and report what it did.
  let stoppedBy = null;
  const onSignal = (signal) => {
    stoppedBy = signal;
    child.kill('SIGTERM');
  };
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
  for (const s of signals) process.on(s, onSignal);
  const stats = { commands: 0, files: new Set(), tokens: { input: 0, output: 0 } };
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    fs.writeSync(log, chunk);
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === 'thread.started' && event.thread_id && !run.thread) {
        run.thread = event.thread_id;
        saveRun(run);
      }
      const item = event.item || {};
      if (event.type === 'item.completed' && item.type === 'command_execution') stats.commands++;
      if (event.type === 'item.completed' && item.type === 'file_change') for (const c of item.changes || []) stats.files.add(c.path);
      if (event.type === 'error' || event.type === 'turn.failed') run.errorText = String(event.message || event.error?.message || JSON.stringify(event)).slice(0, 500);
      if (event.type === 'turn.completed' && event.usage) {
        stats.tokens.input += event.usage.input_tokens || 0;
        stats.tokens.output += event.usage.output_tokens || 0;
      }
    }
  });
  let timedOut = false;
  let killTimer = null;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
  }, timeoutMs());
  const progress = setInterval(() => post(run, { kind: 'message', text: `Codex is still working on "${run.title}" (run ${run.id}): ${stats.commands} commands${stats.files.size ? `, ${stats.files.size} files changed` : ''} so far.` }), PROGRESS_MS);
  let spawnError = null;
  const code = await new Promise((resolve) => {
    child.on('close', resolve);
    child.on('error', (error) => {
      spawnError = error.message;
      resolve(-1);
    });
  });
  clearTimeout(timer);
  clearTimeout(killTimer);
  clearInterval(progress);
  for (const s of signals) process.off(s, onSignal);
  fs.closeSync(log);
  fs.closeSync(errLog);
  return { code, timedOut, stats, stoppedBy, spawnError };
}

async function finish(run, { code, timedOut, stats, stoppedBy, spawnError }, startedAt) {
  const reason = timedOut
    ? 'stopped after 30 minutes'
    : stoppedBy
      ? `the launcher was stopped (${stoppedBy})`
      : spawnError
        ? `Codex couldn't start: ${spawnError}`
        : code !== 0
          ? `Codex exited with code ${code}`
          : null;
  // A usage or rate limit on the user's plan: runs the Claudes start by themselves pause
  // until tomorrow. (Checked in Codex's errors only, never in its answer text.)
  let errTail = '';
  try {
    errTail = fs.readFileSync(run.logFile.replace(/\.jsonl$/, '.err'), 'utf8').slice(-4000);
  } catch {}
  const limited = Boolean(reason || run.errorText) && LIMIT_TEXT.test(`${run.errorText || ''}\n${errTail}`);
  if (limited && policy().pauseOnLimit && !pausedToday()) {
    writeJson(PAUSE, { day: today(), reason: (run.errorText || errTail.trim().split('\n').pop() || '').slice(0, 300) });
    post(run, { kind: 'message', everywhere: true, to: undefined, text: "Codex hit a usage or rate limit on the user's plan. Automatic Codex use (--auto) is paused for the rest of today; tell the user once." });
  }
  let last = '';
  try {
    last = fs.readFileSync(run.lastFile, 'utf8').trim();
  } catch {}
  let commit = null;
  let stat = '';
  if (run.write) {
    try {
      commit = commitResult(run, reason);
      stat = git(run.dir, ['diff', '--stat', run.snapshot, 'HEAD']);
    } catch (error) {
      stat = `(couldn't commit Codex's changes: ${error.message})`;
    }
  }
  const tokens = run.tokens || { input: 0, output: 0 };
  tokens.input += stats.tokens.input;
  tokens.output += stats.tokens.output;
  Object.assign(run, {
    status: limited ? 'limited' : reason ? (timedOut ? 'timed-out' : stoppedBy ? 'stopped' : 'failed') : /^BLOCKED:/m.test(last) ? 'blocked' : 'done',
    pid: null,
    launcherPid: null,
    endedAt: Date.now(),
    seconds: Math.round((Date.now() - startedAt) / 1000),
    tokens,
    commit: commit || run.commit || null,
    lastMessage: last.slice(0, 4000),
  });
  saveRun(run);
  const changed = run.write
    ? (stat ? `\nChanges on ${run.branch}:\n${stat.split('\n').slice(-12).join('\n')}` : `\nNo file changes on ${run.branch}.`) +
      (run.leftOut?.length ? `\nLeft out of the commit (new files over 50 MB): ${run.leftOut.slice(0, 10).join(', ')}` : '')
    : '';
  const summary = `Codex ${run.status === 'done' ? 'finished' : run.status} "${run.title}" (run ${run.id}, ${run.seconds}s, ${tokens.input + tokens.output} tokens${reason ? `; ${reason}` : ''}).${changed}\n\nCodex's last message:\n${last.slice(0, 1500) || '(none)'}\n\nReview with: node ${fileURLToPath(import.meta.url)} show ${run.id}`;
  post(run, { kind: 'message', text: summary });
  console.log(summary);
}

async function runCommand(opts) {
  if (!opts.project) die('give the project folder with --project <dir>');
  const requested = path.resolve(opts.project.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) die(`no such folder: ${requested}`);
  const project = fs.realpathSync(requested);
  const task = taskText(opts);
  for (const r of readRuns()) if (stale(r)) finalizeStale(r);
  const running = readRuns().filter((r) => r.status === 'running');
  if (!policy().enabled) die('Codex is turned off in policy.json.');
  if (opts.auto && !policy().autoUse) die('Bringing in Codex automatically is off in policy.json; use it only when the user asks.');
  if (opts.write && !policy().allowWrite) die('Codex edits are turned off in policy.json; use a read-only or --review run.');
  if (running.length >= maxRunning()) die(`${running.length} Codex runs are already going (${running.map((r) => r.id).join(', ')}); wait for one to finish.`);
  codexBin();
  let root = null;
  try {
    root = git(project, ['rev-parse', '--show-toplevel']);
  } catch {}
  // The user's answer for this project, and the daily pause (docs/policies.md).
  const consent = policy().consentRequired ? consentFor(project, root) : { answer: 'on', source: 'policy (consent not required)' };
  if (!consent) die(`Codex hasn't been allowed for this project yet. Ask the user once: "OK to send this project's code to OpenAI via Codex? on / review-only / off". After they answer, record it with: node ${fileURLToPath(import.meta.url)} consent "${project}" <answer>`);
  if (consent.answer === 'off') die(`Codex is off for this project (${consent.source}). Don't use it here unless the user changes that.`);
  if (consent.answer === 'review-only' && opts.write) die('This project is review-only for Codex: no edits, not even in its own copy. Use --review or a read-only run.');
  if (opts.write && opts.review) die('choose --write or --review, not both');
  if (opts.auto && pausedToday()) die(`Automatic Codex is paused for today after a usage or rate limit (${pausedToday().reason || 'no details'}). Only run it if the user asks.`);
  if (opts.review && !root) die('--review needs a git project (it reviews the changes). Without it, a read-only run sees the folder.');
  if (opts.write && !root) die('--write needs a git project (Codex edits a separate copy made with git). Without --write, Codex can still read and answer.');
  if (opts.write) {
    try {
      git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    } catch {
      die("--write needs at least one commit in the project (Codex's copy starts from it). Commit once, or run without --write.");
    }
  }
  const title = (opts.title || task.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 80);
  const id = `cx-${Date.now().toString(36)}`;
  const run = {
    id,
    title,
    // The Claude that started it: given, or worked out from its account's config folder.
    from: opts.from || whoAmI(),
    project: projectKey(project),
    folder: project,
    write: Boolean(opts.write),
    review: Boolean(opts.review),
    quiet: Boolean(opts.quiet),
    auto: Boolean(opts.auto),
    network: Boolean(opts.network) || policy().network,
    model: opts.model || null,
    effort: opts.effort || null,
    // The Claude that asked, and its level (given, or noted by the board's hook for its session).
    requester: opts['claude-model'] ? { model: opts['claude-model'], effort: opts['claude-effort'] || null } : selfLevel(),
    git: Boolean(root),
    startedAt: Date.now(),
    logFile: path.join(HOME, 'logs', `${id}.jsonl`),
    lastFile: path.join(HOME, 'logs', `${id}.last.txt`),
    task: task.slice(0, 4000),
  };
  fs.mkdirSync(path.dirname(run.logFile), { recursive: true });
  // Codex works at a level comparable to the Claude that asked (models.mjs), unless told otherwise.
  if (!run.model && !run.effort && run.requester) {
    const match = policy().matchRequesterLevel ? codexMatch(run.requester, codexBin()) : null;
    if (match) Object.assign(run, { model: match.model, effort: match.effort, matched: match.why });
  }
  let skipped = [];
  if (opts['dry-run']) {
    console.log(`Codex would run as ${run.model || 'its default model'} at ${run.effort || 'its default'} effort${run.matched ? ` (${run.matched})` : ''}.`);
    if (run.review) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-review-'));
      try {
        console.log(`Dry run: Codex would review a sandbox with:\n${manifestText(buildReview(root, project, opts, tmp))}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } else console.log(`Dry run: Codex would ${run.write ? 'edit its own copy of' : 'read'} the whole folder ${project} (consent: ${consent.answer}).`);
    return;
  }
  if (run.review) {
    const dir = path.join(REVIEWS, id);
    run.reviewed = buildReview(root, project, opts, dir);
    Object.assign(run, { dir, git: false, root });
  } else if (run.write) {
    const w = makeWorktree(root, title);
    Object.assign(run, { dir: path.join(w.dir, path.relative(root, project)), worktree: w.dir, branch: w.branch, snapshot: w.snapshot, root });
    skipped = w.skipped;
  } else run.dir = project;
  saveRun(run);
  post(run, {
    kind: 'message',
    text: `Codex started "${title}" (run ${id}) for ${run.from}${run.auto ? ' (brought in automatically)' : ''}${run.model ? `, as ${run.model} at ${run.effort || 'default'} effort${run.requester?.model ? ` to match ${label(run.requester)}` : ''}` : ''}: ${run.write ? `editing its own copy on branch ${run.branch}` : run.review ? `reviewing ${run.reviewed.code.length} code files and the changes since ${run.reviewed.base}${run.reviewed.data.length ? ` (${run.reviewed.data.length} data files by name only)` : ''}${run.reviewed.withheld.length ? `; withheld as possible credentials: ${run.reviewed.withheld.join(', ')}` : ''}` : 'read-only'}${run.network ? ', network on' : ''}.${skipped.length ? ` Left out of its copy (over 50 MB): ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? ` and ${skipped.length - 10} more` : ''}.` : ''}`,
  });
  const result = await execute(run, codexArgs(run, { task }));
  await finish(run, result, run.startedAt);
}

async function resumeCommand(opts) {
  const run = findRun(opts._[1] || die('which run? (node codex.mjs list)'));
  if (!policy().enabled) die('Codex is turned off in policy.json.');
  if (run.auto && !policy().autoUse) die('Bringing in Codex automatically is off in policy.json; use it only when the user asks.');
  if (run.write && !policy().allowWrite) die('Codex edits are turned off in policy.json; use a read-only or --review run.');
  if (!run.thread) die(`run ${run.id} has no Codex conversation to continue.`);
  if (stale(run)) finalizeStale(run);
  if (findRun(run.id).status === 'running') die(`run ${run.id} is still going.`);
  // The user may have changed their answer since; it applies at once.
  const consent = consentFor(run.folder, run.root);
  if (!consent || consent.answer === 'off') die(`Codex is ${consent ? 'off' : 'not allowed yet'} for this project; not continuing.`);
  if (consent.answer === 'review-only' && run.write) die('This project is now review-only for Codex; not continuing an editing run.');
  if (run.write && !fs.existsSync(run.worktree)) die(`run ${run.id}'s copy was cleaned up; start a new run.`);
  const task = taskText(opts);
  run.followUps = [...(run.followUps || []), task.slice(0, 2000)];
  post(run, { kind: 'message', text: `Codex is continuing "${run.title}" (run ${run.id}) with a follow-up from ${run.from}.` });
  const startedAt = Date.now();
  const result = await execute(run, codexArgs(run, { resume: true, task }));
  await finish(run, result, startedAt);
}

// Finishes a run whose launcher died without finishing it: stops Codex if it's still
// going, commits what's in its copy as incomplete, and reports it on the board.
function finalizeStale(run) {
  if (run.pid && alive(run.pid)) {
    try {
      process.kill(run.pid, 'SIGTERM');
    } catch {}
  }
  let commit = null;
  if (run.write && run.worktree && fs.existsSync(run.worktree)) {
    try {
      commit = commitResult(run, 'the launcher stopped');
    } catch {}
  }
  Object.assign(run, { status: 'stopped', pid: null, launcherPid: null, endedAt: Date.now(), commit: commit || run.commit || null });
  saveRun(run);
  post(run, { kind: 'message', text: `Codex's run ${run.id} ("${run.title}") stopped because its launcher did${commit ? `; what it had done is committed on ${run.branch} as incomplete` : ''}.` });
}

function finishCommand(opts) {
  const run = findRun(opts._[1] || die('which run?'));
  if (!stale(run)) die(`run ${run.id} isn't stuck (status ${run.status}).`);
  finalizeStale(run);
  console.log(`Finished run ${run.id} as stopped.`);
}

function showCommand(opts) {
  let run = findRun(opts._[1] || die('which run?'));
  if (stale(run)) finalizeStale(run), (run = findRun(run.id));
  console.log(`${run.id} · ${run.title}\n${run.write ? `branch ${run.branch}, copy at ${run.worktree}` : 'read-only'} · status ${run.status}${run.applied ? ' · applied' : ''} · ${run.seconds ?? '?'}s · tokens ${(run.tokens?.input || 0) + (run.tokens?.output || 0)}\nproject ${run.folder}`);
  if (run.write && run.commit) {
    console.log(`\n${git(run.root, ['diff', '--stat', run.snapshot, run.commit])}\n`);
    console.log(git(run.root, ['diff', run.snapshot, run.commit]).slice(0, 200000));
  } else if (run.write) console.log('\nNo changes committed.');
  console.log(`\nCodex's last message:\n${run.lastMessage || '(none)'}`);
}

// Puts an editing run's changes into the project folder (as uncommitted changes). Only
// after the user says yes. Refuses rather than forcing if they no longer fit.
function applyCommand(opts) {
  const run = findRun(opts._[1] || die('which run?'));
  if (!run.write || !run.commit) die(`run ${run.id} has no changes to apply.`);
  if (run.applied) die(`run ${run.id} was already applied.`);
  const patch = git(run.root, ['diff', '--binary', run.snapshot, run.commit]) + '\n';
  try {
    execFileSync('git', ['-C', run.root, 'apply', '--check', '-'], { input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    die(`Codex's changes no longer fit the project as it is now (nothing was changed):\n${String(error.stderr || error.message).trim()}\nThe branch ${run.branch} still has them; merge it by hand, or start a new run.`);
  }
  execFileSync('git', ['-C', run.root, 'apply', '-'], { input: patch, stdio: ['pipe', 'pipe', 'pipe'] });
  run.applied = Date.now();
  saveRun(run);
  console.log(`Applied run ${run.id}'s changes to ${run.root} as uncommitted changes:\n${git(run.root, ['diff', '--stat', run.snapshot, run.commit])}`);
  post(run, { kind: 'message', text: `Codex's changes from run ${run.id} ("${run.title}") were applied to the project (uncommitted).` });
}

function listCommand() {
  for (const r of readRuns()) if (stale(r)) finalizeStale(r);
  const runs = readRuns().slice(-30).reverse();
  if (!runs.length) return console.log('No Codex runs yet.');
  for (const r of runs) {
    console.log(`${r.id}  ${new Date(r.startedAt).toLocaleString()}  ${r.status}${r.applied ? ', applied' : ''}  ${r.write ? r.branch : r.review ? 'review' : 'read-only'}  ${path.basename(r.folder)}  "${r.title}"`);
  }
}

function cleanupCommand() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  let removed = 0;
  for (const run of readRuns()) {
    if (!run.write || run.cleaned || !run.worktree || run.status === 'running') continue;
    if (!run.applied && run.startedAt > cutoff) continue;
    try {
      git(run.root, ['worktree', 'remove', '--force', run.worktree]);
    } catch {
      fs.rmSync(run.worktree, { recursive: true, force: true });
      try {
        git(run.root, ['worktree', 'prune']);
      } catch {}
    }
    run.cleaned = Date.now();
    saveRun(run);
    removed++;
  }
  // Review sandboxes are only copies of a few files; drop them after 14 days.
  let reviews = 0;
  for (const run of readRuns()) {
    if (!run.review || run.cleaned || run.status === 'running' || run.startedAt > cutoff) continue;
    fs.rmSync(run.dir, { recursive: true, force: true });
    run.cleaned = Date.now();
    saveRun(run);
    reviews++;
  }
  console.log(`Removed ${removed} Codex cop${removed === 1 ? 'y' : 'ies'} (their branches are kept) and ${reviews} review sandbox${reviews === 1 ? '' : 'es'}.`);
}

const opts = args(process.argv.slice(2));
const commands = { run: runCommand, resume: resumeCommand, show: showCommand, apply: applyCommand, list: listCommand, cleanup: cleanupCommand, finish: finishCommand, consent: consentCommand };
const command = commands[opts._[0]];
if (!command) die('use run, resume, show, apply, list, cleanup, finish or consent (see the top of this file)');
try {
  await command(opts);
} catch (error) {
  die(error.message);
}
