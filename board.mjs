// The message board shared by the user's AI agents: one event log on this computer for all
// projects. Each event is tagged with its project (a git repo's main folder, so branch
// folders count as the same project), and readers see their own project's events plus ones
// posted to every project. No dependencies. Agents and policy come from lib/config.mjs and
// lib/policy.mjs; files live where lib/paths.mjs says.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { whoAmI } from './lib/config.mjs';
import { DATA_DIR } from './lib/paths.mjs';
import { loadPolicy } from './lib/policy.mjs';

export { whoAmI };
export const BOARD_DIR = DATA_DIR;
const LOG = path.join(BOARD_DIR, 'events.jsonl');
const CURSORS = path.join(BOARD_DIR, 'cursors');
const JOINED = path.join(BOARD_DIR, 'joined');

const claimHours = () => loadPolicy().collaboration.claimHours;
const KEEP_DAYS = 14;

const keyCache = new Map();
// A project's key: the main folder of its git repo (worktrees and subfolders included),
// or the folder itself outside git.
export function projectKey(dir) {
  const folder = path.resolve(dir || process.cwd());
  if (keyCache.has(folder)) return keyCache.get(folder);
  let key = folder;
  try {
    const common = execFileSync('git', ['-C', folder, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    key = path.basename(common) === '.git' ? path.dirname(common) : common;
  } catch {}
  try {
    key = fs.realpathSync.native(key);
  } catch {}
  keyCache.set(folder, key);
  return key;
}

// The project a file belongs to (its folder may not exist yet for a new file).
export function fileProject(file) {
  let dir = path.dirname(path.resolve(file));
  while (!fs.existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
  return projectKey(dir);
}

const within = (a, b) => a === b || a.startsWith(b + path.sep);
// Whether an event belongs to the project with key `key`.
export const inProject = (event, key) => event.everywhere || within(event.project, key) || within(key, event.project);

export function append(event) {
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  const full = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), ...event };
  // One write per line with O_APPEND, so two Claudes writing at once don't interleave.
  fs.appendFileSync(LOG, JSON.stringify(full) + '\n');
  return full;
}

export function readAll() {
  let text = '';
  try {
    text = fs.readFileSync(LOG, 'utf8');
  } catch {
    return [];
  }
  return parseLines(text);
}

function parseLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

// Drops events older than two weeks, rarely (when the log passes 2 MB).
export function compact() {
  try {
    if (fs.statSync(LOG).size < 2e6) return;
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    const before = fs.readFileSync(LOG);
    const kept = parseLines(before.toString('utf8')).filter((e) => e.at >= cutoff);
    const tmp = `${LOG}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
    // Anything another agent posted while this ran goes along too, or the swap below
    // would drop it. (Only the instant between this read and the rename is left uncovered.)
    const now = fs.readFileSync(LOG);
    if (now.length > before.length && now.subarray(0, before.length).equals(before)) fs.appendFileSync(tmp, now.subarray(before.length));
    fs.renameSync(tmp, LOG);
  } catch {}
}

// Current claims in a project: file -> { by, note, at }. Expire after the policy's claimHours.
export function claims(events, key) {
  const now = Date.now();
  const map = new Map();
  for (const e of events) {
    if (!inProject(e, key)) continue;
    if (e.kind === 'claim') for (const f of e.files || []) map.set(f, { by: e.from, note: e.text || '', at: e.at });
    if (e.kind === 'release') for (const f of e.files || []) if (e.force || map.get(f)?.by === e.from) map.delete(f);
    if (e.kind === 'release-all') for (const [f, c] of map) if (c.by === e.from) map.delete(f);
  }
  for (const [f, c] of map) if (now - c.at > claimHours() * 3600e3) map.delete(f);
  return map;
}

// A path with its folder's symlinks resolved (/tmp → /private/tmp), as project keys are.
export function realPath(file) {
  const full = path.resolve(file);
  try {
    return path.join(fs.realpathSync.native(path.dirname(full)), path.basename(full));
  } catch {
    return full;
  }
}

// Who holds a claim on one file (a full path), whichever folder the claim was made from:
// claims are stored relative to the claimer's project, which may be a parent of the file's
// own repo (e.g. a session in a folder above the repo). null if nobody does.
export function claimOn(events, file) {
  const full = realPath(file);
  const names = (e) => (e.files || []).some((f) => path.resolve(e.project, f) === full);
  let held = null;
  for (const e of events) {
    if (e.kind === 'claim' && names(e)) held = { by: e.from, note: e.text || '', at: e.at, project: e.project };
    else if (held && e.kind === 'release' && (e.force || e.from === held.by) && names(e)) held = null;
    else if (held && e.kind === 'release-all' && e.from === held.by && (within(held.project, e.project) || within(e.project, held.project))) held = null;
  }
  return held && Date.now() - held.at <= claimHours() * 3600e3 ? held : null;
}

const requestHours = () => loadPolicy().collaboration.requestHours;

// Open help requests (briefs) in a project, newest last. Ones nobody closed lapse after
// the policy's requestHours, so a forgotten request can't send a later helper to old work.
export function openBriefs(events, key) {
  const closed = new Set(events.filter((e) => e.kind === 'brief-closed').map((e) => e.brief));
  const cutoff = Date.now() - requestHours() * 3600e3;
  return events.filter((e) => e.kind === 'brief' && e.at >= cutoff && inProject(e, key) && !closed.has(e.id));
}

export function ago(at) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(at).toLocaleString();
}

// One event as a line of text for Claude.
export function describe(e) {
  const where = e.everywhere ? ' (to all projects)' : '';
  const head = `[${e.from}${e.to ? ` to ${e.to}` : ''}, ${ago(e.at)}${where}]`;
  switch (e.kind) {
    case 'brief':
      return `${head} HELP REQUEST (id ${e.id})${e.model ? `, asked at ${e.model}${e.effort ? ` · ${e.effort} effort` : ''}` : ''}:\nGoal: ${e.goal}\nDone so far: ${e.done || '—'}\nWants help with: ${e.helpWith}${e.files?.length ? `\nFiles involved: ${e.files.join(', ')}` : ''}${e.text ? `\nNotes: ${e.text}` : ''}`;
    case 'brief-closed':
      return `${head} closed their help request: ${e.text || 'done'}`;
    case 'join':
      return `${head} is here to help in this project.${e.text ? ` ${e.text}` : ''}`;
    case 'debate':
      return `${head} DEBATE ${e.id}: "${e.title}" (participants: ${e.participants.join(', ')}; round 1 opens ${new Date(e.deadline).toLocaleTimeString()} at the latest).\nIf you're a participant, give your own round-1 view with debate_submit (round 1) before reading anything else about it.\n\n${e.question}`;
    case 'debate-view':
      return `${head} sealed its round-1 view in debate ${e.debate}.`;
    case 'debate-reveal':
      return `${head} DEBATE ${e.debate}, round 1 revealed:\n\n${e.views.map((v) => `=== ${v.from} (confidence ${v.confidence ?? '?'}) ===\n${v.text}`).join('\n\n')}${e.missing?.length ? `\n\n(No view from: ${e.missing.join(', ')}.)` : ''}\n\nRound 2: respond once with debate_submit (round 2, at most 200 words), answering the strongest argument against your position.`;
    case 'debate-reply':
      return `${head} DEBATE ${e.debate}, round 2:\n${e.text}`;
    case 'debate-accept':
      return `${head} DEBATE ${e.debate}, round 3: ${e.text}`;
    case 'debate-close':
      return `${head} closed debate ${e.debate}, decided by ${e.decidedBy}: ${e.summary}`;
    case 'helper-started':
      return `${head} started a helper session for help request ${e.brief}; it will join shortly.`;
    case 'claim':
      return `${head} claimed ${e.files.join(', ')}${e.text ? ` — ${e.text}` : ''}`;
    case 'release':
    case 'release-all':
      return `${head} released ${e.kind === 'release-all' ? 'all their files' : e.files.join(', ')}`;
    default:
      return `${head} ${e.text}`;
  }
}

// Read position of one Claude session (hooks), stored per session id.
export function cursor(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(CURSORS, `${sessionId.replace(/[^\w-]/g, '')}.json`), 'utf8')).at;
  } catch {
    return null;
  }
}

export function setCursor(sessionId, at) {
  fs.mkdirSync(CURSORS, { recursive: true });
  fs.writeFileSync(path.join(CURSORS, `${sessionId.replace(/[^\w-]/g, '')}.json`), JSON.stringify({ at }));
}

// ---------- sessions working outside their starting folder ----------
// A session can join a project other than the folder it started in (the board tools'
// project option). Its board server records that under the Claude process's id, and the
// hook, a child of the same Claude process, finds it by walking up its parent processes.

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

export function setJoined(pid, folder) {
  fs.mkdirSync(JOINED, { recursive: true });
  fs.writeFileSync(path.join(JOINED, `${pid}.json`), JSON.stringify({ folder }));
}

export function clearJoined(pid) {
  fs.rmSync(path.join(JOINED, `${pid}.json`), { force: true });
}

// The project folder a session joined, found from any process above this one; null if none.
export function joinedFolder() {
  let names;
  try {
    names = fs.readdirSync(JOINED).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  if (!names.length) return null;
  const parents = new Map();
  try {
    for (const line of execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 }).split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid) parents.set(pid, ppid);
    }
  } catch {
    return null;
  }
  for (let pid = process.ppid, depth = 0; pid > 1 && depth < 10; pid = parents.get(pid), depth++) {
    if (!names.includes(`${pid}.json`)) continue;
    try {
      return JSON.parse(fs.readFileSync(path.join(JOINED, `${pid}.json`), 'utf8')).folder;
    } catch {
      return null;
    }
  }
  // Tidy records left by Claude processes that are gone.
  for (const name of names) if (!alive(Number(name.slice(0, -5)))) clearJoined(name.slice(0, -5));
  return null;
}

// Whether an event is for `me`: addressed to nobody in particular, or to me.
export const forMe = (event, me) => !event.to || event.to === me;

// Round-1 debate views stay sealed: nobody but their author sees them on the board until the
// reveal, which carries them all at once (DEBATE-POLICY.md, section 3).
export const hideSealed = (events, me) => events.filter((e) => e.kind !== 'debate-view' || e.from === me);

// ---------- the model and effort each Claude session is using ----------
// The hook notes them (from the hook input and the session transcript) under the Claude
// process's id; tools started by that Claude (the board server, codex.mjs, debate.mjs) find
// them by walking up their parent processes, so help requests carry the requester's level.

const SELF = path.join(BOARD_DIR, 'self');
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const parentOf = (pid) => {
  try {
    return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim()) || 0;
  } catch {
    return 0;
  }
};

// The newest model and effort recorded in a session transcript (last ~400 KB).
export function sessionLevel(transcriptPath) {
  let tail = '';
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 400 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    tail = buf.toString('utf8');
  } catch {
    return {};
  }
  let model = null;
  let effort = null;
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0 && (!model || !effort); i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!model && entry.type === 'assistant' && /^claude-/.test(entry.message?.model || '')) model = entry.message.model;
    const e = entry.perTurnEffort || entry.effort;
    if (!effort && EFFORTS.includes(e)) effort = e;
  }
  return { model, effort };
}

// Called by the hook: notes this session's level for its Claude process (and the shell in
// between, if any), rewriting only when it changed.
export function recordSelf(level) {
  if (!level?.model && !level?.effort) return;
  fs.mkdirSync(SELF, { recursive: true });
  const body = JSON.stringify({ model: level.model || null, effort: level.effort || null });
  for (const pid of [process.ppid, parentOf(process.ppid)].filter((p) => p > 1)) {
    const file = path.join(SELF, `${pid}.json`);
    try {
      if (fs.readFileSync(file, 'utf8') === body) continue;
    } catch {}
    fs.writeFileSync(file, body);
  }
}

// The level of the Claude session this process belongs to, or null.
export function selfLevel() {
  let names;
  try {
    names = new Set(fs.readdirSync(SELF));
  } catch {
    return null;
  }
  for (let pid = process.ppid, depth = 0; pid > 1 && depth < 8; pid = parentOf(pid), depth++) {
    if (!names.has(`${pid}.json`)) continue;
    try {
      return JSON.parse(fs.readFileSync(path.join(SELF, `${pid}.json`), 'utf8'));
    } catch {
      return null;
    }
  }
  return null;
}
