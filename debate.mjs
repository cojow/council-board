#!/usr/bin/env node
// Debates between the user's agents, run the way the policy says (docs/policies.md): a neutral question;
// round 1, independent views, sealed until everyone has answered or the deadline passes;
// round 2, one critique each; round 3, AGREED or OBJECTION on the merged wording. Then a
// private full record and a short note in the project.
//
// The starter (a Claude agent) runs this from Bash. Other Claude agents take part through
// the board's debate_submit tool (each gets a help request to join). Codex takes part through
// codex.mjs: each round is a fresh read-only run given only that round's material.
// Budgets, deadlines, word limits and who may decide come from policy.json.
//
// Usage:
//   node debate.mjs start --project <dir> --title "<short>" --question-file <f> --view-file <f> --confidence <0-1>
//                         [--participants "<name>,<name>,…"] [--minutes <n>] [--auto]
//   node debate.mjs codex <debate> <1|2|3> [--file <merged wording, for round 3>]   Codex's turn
//   node debate.mjs submit <debate> <1|2|3> --file <f> [--confidence <0-1>]            your own turn (round 3: AGREED or OBJECTION: …)
//   node debate.mjs status <debate>        who has answered; reveals round 1 when it's due
//   node debate.mjs close <debate> --outcome-file <f> --decided-by AIs|user|pending-user [--dissent "<text>"] [--revisit YYYY-MM-DD]
//   node debate.mjs list [--project <dir>]  recent debates and decisions (to spot repeats within 30 days)
//   node debate.mjs notes <project> on|off  in-project decision notes for that project (default on)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { append, BOARD_DIR, projectKey, readAll, selfLevel, whoAmI } from './board.mjs';
import { claudeAgents, codexAgent, loadAgents } from './lib/config.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { label } from './models.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DECISIONS = path.join(BOARD_DIR, 'decisions');
const SETTINGS = path.join(DECISIONS, 'settings.json');
const debatePolicy = () => loadPolicy().debates;
// Codex takes part only if it's configured and enabled in the policy.
const codexName = () => (loadPolicy().codex.enabled ? codexAgent()?.name : null) || null;
const everyone = () => [...claudeAgents().map((a) => a.name), ...(codexName() ? [codexName()] : [])];

const die = (message) => {
  console.error(`debate.mjs: ${message}`);
  process.exit(1);
};
const words = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;
const slugify = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'debate';
const day = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA');
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// ---------- the debate's state, worked out from the board ----------

export function debateState(id, events = readAll()) {
  const start = events.find((e) => e.kind === 'debate' && e.id === id);
  if (!start) return null;
  const mine = events.filter((e) => e.debate === id);
  const by = (kind) => mine.filter((e) => e.kind === kind);
  const latest = (list) => Object.values(Object.fromEntries(list.map((e) => [e.from, e])));
  return {
    start,
    views: latest(by('debate-view')),
    replies: latest(by('debate-reply')),
    accepts: latest(by('debate-accept')),
    reveal: by('debate-reveal')[0] || null,
    close: by('debate-close')[0] || null,
  };
}

// Reveals round 1 when every participant has a view or the deadline has passed. Called by
// whoever looks first (this tool, the board tools, the hook), so it happens on time.
export function maybeReveal(events = readAll()) {
  for (const start of events.filter((e) => e.kind === 'debate')) {
    const s = debateState(start.id, events);
    if (s.reveal || s.close) continue;
    const answered = new Set(s.views.map((v) => v.from));
    const missing = start.participants.filter((p) => !answered.has(p));
    if (missing.length && Date.now() < start.deadline) continue;
    append({ from: start.from, project: start.project, kind: 'debate-reveal', debate: start.id, views: s.views.map((v) => ({ from: v.from, text: v.text, confidence: v.confidence ?? null })), missing });
  }
}

// One participant's turn. Round 1 is sealed (stored, but no reader shows it until the reveal).
export function submitTurn(id, round, { from, text, confidence }) {
  round = Number(round);
  if (![1, 2, 3].includes(round)) throw new Error('round must be 1, 2 or 3');
  const s = debateState(id);
  if (!s) throw new Error(`no debate ${id}`);
  if (s.close) throw new Error(`debate ${id} is closed`);
  if (!s.start.participants.includes(from)) throw new Error(`${from} isn't a participant in debate ${id}`);
  const body = String(text || '').trim();
  if (!body) throw new Error('the turn is empty');
  const limit = debatePolicy().maxWords[round];
  if (words(body) > limit) throw new Error(`round ${round} turns are at most ${limit} words (this one has ${words(body)}); shorten it`);
  const base = { from, project: s.start.project, debate: id, round: Number(round), text: body, confidence: confidence == null || confidence === '' ? null : Number(confidence) };
  if (Number(round) === 1) {
    if (s.reveal) throw new Error('round 1 is already revealed; submit round 2 instead');
    append({ ...base, kind: 'debate-view' });
    maybeReveal();
  } else if (Number(round) === 2) {
    if (!s.reveal) throw new Error('round 1 isn\'t revealed yet (it opens when everyone has answered or at the deadline)');
    append({ ...base, kind: 'debate-reply' });
  } else {
    const verdict = /^\s*AGREED\b/i.test(body) ? 'AGREED' : /^\s*OBJECTION\b/i.test(body) ? 'OBJECTION' : null;
    if (!verdict) throw new Error('round 3 starts with AGREED or OBJECTION: <the change and why>');
    append({ ...base, kind: 'debate-accept', verdict });
  }
}

// ---------- commands ----------

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (a === '--auto') out.auto = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

const readFile = (file, what) => {
  if (!file) die(`give ${what}`);
  return fs.readFileSync(file, 'utf8').trim();
};

function startCommand(opts) {
  const folder = path.resolve(String(opts.project || die('give --project <dir>')).replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(folder)) die(`no such folder: ${folder}`);
  const project = projectKey(folder);
  const from = opts.from || whoAmI();
  const question = readFile(opts['question-file'], '--question-file (the neutral question)');
  const view = readFile(opts['view-file'], '--view-file (your own round-1 view, sealed before the others see the question)');
  const policy = debatePolicy();
  if (!policy.enabled) die('debates are turned off in policy.json');
  if (opts.auto && !policy.selfStarted) die('self-started debates are off in policy.json; start one only when the user asks');
  const ALL = everyone();
  const participants = String(opts.participants || ALL.join(',')).split(',').map((p) => p.trim()).filter(Boolean);
  for (const p of participants) if (!ALL.includes(p)) die(`unknown participant "${p}" (use ${ALL.join(', ')})`);
  if (!participants.includes(from)) participants.unshift(from);
  // The standing budget (policy.json: debates.budget).
  const events = readAll();
  const debates = events.filter((e) => e.kind === 'debate' && e.project === project);
  const closed = new Set(events.filter((e) => e.kind === 'debate-close').map((e) => e.debate));
  const active = debates.filter((d) => !closed.has(d.id) && Date.now() - d.at < 2 * 3600e3);
  if (active.length >= policy.budget.openPerProject) die(`debate ${active[0].id} ("${active[0].title}") is still open in this project; close it first (one at a time per project).`);
  if (debates.filter((d) => day(d.at) === day()).length >= policy.budget.perProjectPerDay) die(`${policy.budget.perProjectPerDay} debates already today in this project (the standing budget); ask the user before another.`);
  const minutes = Math.min(30, Math.max(2, Number(opts.minutes) || policy.deadlineMinutes));
  const title = String(opts.title || question.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 80);
  // Everyone debates at the starter's level: other Claude agents' helpers use the same model
  // and effort, Codex the matching ones (models.mjs).
  const level = opts.model || opts.effort ? { model: opts.model || null, effort: opts.effort || null } : selfLevel() || {};
  const start = append({ from, project, kind: 'debate', title, question, participants, deadline: Date.now() + minutes * 60e3, auto: Boolean(opts.auto), level });
  submitTurn(start.id, 1, { from, text: view, confidence: opts.confidence });
  // Each other Claude agent joins through a help request addressed to it (an app that starts
  // helper sessions may pick it up; otherwise the user tells that agent to help).
  for (const name of participants.filter((p) => p !== from && p !== codexName())) {
    append({
      from,
      to: name,
      project,
      kind: 'brief',
      wake: true,
      ...level,
      goal: `DEBATE ${start.id}: give your independent round-1 view on "${title}"`,
      done: `${from} has sealed its own view. Round 1 opens for everyone when all have answered, or in ${minutes} minutes.`,
      helpWith: `${question}\n\nSubmit your view with the board's debate_submit tool (debate "${start.id}", round 1, at most ${policy.maxWords[1]} words, with a confidence 0-1). Do it before reading other posts about this debate. Then wait for the reveal and take part in rounds 2 and 3 with the same tool. Don't edit files. Rules: ${path.join(HERE, 'docs', 'policies.md')}.`,
      files: [],
      text: 'Silence or a timeout never counts as agreement.',
    });
  }
  console.log(`Started debate ${start.id} ("${title}") with ${participants.join(', ')}, at ${label(level)}. Your view is sealed; round 1 opens when all have answered or in ${minutes} minutes.`);
  if (codexName() && participants.includes(codexName())) console.log(`${codexName()}'s turn: node ${path.join(HERE, 'debate.mjs')} codex ${start.id} 1`);
}

// Codex's turn: a fresh read-only run with only this round's material, so earlier rounds
// aren't re-sent (cheaper) and its first view can't see anyone else's.
function codexCommand(opts) {
  const id = opts._[1] || die('which debate?');
  const round = Number(opts._[2] || die('which round (1, 2 or 3)?'));
  const s = debateState(id) || die(`no debate ${id}`);
  const CODEX = codexName() || die('Codex isn\'t configured or is off in policy.json');
  if (!s.start.participants.includes(CODEX)) die(`${CODEX} isn't in debate ${id}`);
  const material =
    round === 1
      ? `${s.start.question}\n\nGive your own view first (you haven't seen anyone else's): at most 350 words, with a confidence for each point.`
      : round === 2
        ? `${s.start.question}\n\n${(s.reveal?.views || []).map((v) => `=== ${v.from} (round 1, confidence ${v.confidence ?? '?'}) ===\n${v.text}`).join('\n\n') || die('round 1 isn\'t revealed yet')}${s.reveal?.missing?.length ? `\n\n(No round-1 view from: ${s.reveal.missing.join(', ')}.)` : ''}\n\nRound 2: respond once, in at most 200 words. For each disagreement, answer the strongest argument against your position, say whether you change your mind, and give your updated confidence. Silence on a point means no change.`
        : `${readFile(opts.file, '--file (the merged wording)')}\n\nRound 3: reply with exactly "AGREED" or "OBJECTION: <the change you need and why>", plus your confidence in this merged answer. At most 80 words.`;
  const task = path.join(os.tmpdir(), `debate-${id}-codex-${round}.md`);
  fs.writeFileSync(task, `${material}\n\nEnd with a line "Confidence: <0-1>" for your overall view.`);
  const level = s.start.level?.model ? ['--claude-model', s.start.level.model, ...(s.start.level.effort ? ['--claude-effort', s.start.level.effort] : [])] : [];
  const run = spawnSync('node', [path.join(HERE, 'codex.mjs'), 'run', '--project', s.start.project, '--task-file', task, '--title', `Debate ${id}, round ${round}`, '--from', s.start.from, '--quiet', ...level, ...(s.start.auto ? ['--auto'] : [])], { encoding: 'utf8' });
  fs.rmSync(task, { force: true });
  const runId = /run (cx-[a-z0-9]+)/.exec(`${run.stdout}${run.stderr}`)?.[1];
  const record = runId ? readJson(path.join(BOARD_DIR, 'codex', 'runs', `${runId}.json`), null) : null;
  if (!record || record.status !== 'done' || !record.lastMessage) {
    const why = (run.stderr || run.stdout || '').trim().split('\n').pop() || record?.status || 'no answer';
    append({ from: CODEX, project: s.start.project, kind: 'message', to: s.start.from, text: `${CODEX} couldn't take its round-${round} turn in debate ${id}: ${why}` });
    die(`Codex's turn failed: ${why}`);
  }
  const confidence = /Confidence:\s*([01](?:\.\d+)?)/i.exec(record.lastMessage)?.[1];
  const text = record.lastMessage.replace(/\n*\**Confidence:\**\s*[01](?:\.\d+)?\**\s*$/i, '').trim();
  try {
    submitTurn(id, round, { from: CODEX, text, confidence });
  } catch (error) {
    die(`Codex answered, but its turn couldn't be recorded: ${error.message}`);
  }
  console.log(`Codex took its round-${round} turn in debate ${id} (run ${runId}, ${(record.tokens?.input || 0) + (record.tokens?.output || 0)} tokens).${round === 1 ? ' Its view stays sealed until the reveal.' : `\n\n${text}`}`);
}

function submitCommand(opts) {
  const id = opts._[1] || die('which debate?');
  const round = Number(opts._[2] || die('which round?'));
  try {
    submitTurn(id, round, { from: opts.from || whoAmI(), text: readFile(opts.file, '--file'), confidence: opts.confidence });
  } catch (error) {
    die(error.message);
  }
  console.log(`Recorded your round-${round} turn in debate ${id}.`);
}

function statusCommand(opts) {
  maybeReveal();
  const id = opts._[1] || die('which debate?');
  const s = debateState(id) || die(`no debate ${id}`);
  const names = (list) => list.map((e) => `${e.from}${e.verdict ? ` ${e.verdict}` : ''}${e.confidence != null ? ` (${e.confidence})` : ''}`).join(', ') || 'nobody yet';
  console.log(`Debate ${id}: "${s.start.title}" · started by ${s.start.from} · participants ${s.start.participants.join(', ')}`);
  console.log(`Round 1: ${s.reveal ? `revealed${s.reveal.missing.length ? `, missing ${s.reveal.missing.join(', ')}` : ''}` : `sealed, answered: ${s.views.map((v) => v.from).join(', ')}; opens ${new Date(s.start.deadline).toLocaleTimeString()} at the latest`}`);
  if (s.reveal) for (const v of s.reveal.views) console.log(`\n=== ${v.from} (round 1, confidence ${v.confidence ?? '?'}) ===\n${v.text}`);
  console.log(`\nRound 2: ${names(s.replies)}`);
  for (const r of s.replies) console.log(`\n=== ${r.from} (round 2) ===\n${r.text}`);
  console.log(`\nRound 3: ${names(s.accepts)}`);
  for (const a of s.accepts) console.log(`  ${a.from}: "${a.text}"`);
  if (s.close) console.log(`\nClosed: decided by ${s.close.decidedBy}. Record: ${s.close.record}`);
}

// Writes the private full record and the short in-project note, and closes the debate.
function closeCommand(opts) {
  maybeReveal();
  const id = opts._[1] || die('which debate?');
  const s = debateState(id) || die(`no debate ${id}`);
  if (s.close) die(`debate ${id} is already closed`);
  const outcome = readFile(opts['outcome-file'], '--outcome-file (the decision and its reasons)');
  const decidedBy = opts['decided-by'] || die('give --decided-by AIs|user|pending-user');
  if (!['AIs', 'user', 'pending-user'].includes(decidedBy)) die('--decided-by is AIs, user or pending-user');
  if (decidedBy === 'AIs') {
    // Everyone accepted, each with a stated confidence at or above the policy's bar (a missing
    // confidence never counts), and the policy lets the agents settle matters at all.
    const { aiDecisions, minConfidence } = debatePolicy();
    if (!aiDecisions) die('policy.json says every outcome goes to the user; use --decided-by pending-user.');
    const accepted = s.start.participants.every((p) => s.accepts.find((a) => a.from === p && a.verdict === 'AGREED'));
    const sure = s.accepts.every((a) => typeof a.confidence === 'number' && a.confidence >= minConfidence);
    if (!accepted || !sure) die(`the agents can only decide if every participant said AGREED with a stated confidence of ${minConfidence} or more; use --decided-by pending-user and take it to the user.`);
  }
  const date = day();
  const slug = slugify(s.start.title);
  const dir = path.join(DECISIONS, slugify(s.start.project));
  fs.mkdirSync(dir, { recursive: true });
  const record = path.join(dir, `${date}-${slug}.md`);
  const quote = (t) => t.split('\n').map((l) => `> ${l}`).join('\n');
  fs.writeFileSync(
    record,
    [
      `# ${s.start.title}`,
      '',
      `Debate ${id} · ${date} · project ${s.start.project} · started by ${s.start.from}${s.start.auto ? ' (on its own initiative)' : ''}`,
      `Participants: ${s.start.participants.join(', ')}${s.reveal?.missing?.length ? ` · missing in round 1: ${s.reveal.missing.join(', ')}` : ''}`,
      `Decided by: ${decidedBy}${opts.revisit ? ` · revisit ${opts.revisit}` : ''}`,
      '',
      '## Outcome',
      '',
      outcome,
      opts.dissent ? `\n**Dissent:** ${opts.dissent}` : '',
      '',
      '## Question',
      '',
      s.start.question,
      '',
      '## Round 1: independent views',
      '',
      ...(s.reveal?.views || []).flatMap((v) => [`### ${v.from} (confidence ${v.confidence ?? '?'})`, '', v.text, '']),
      '## Round 2: critiques',
      '',
      ...s.replies.flatMap((r) => [`### ${r.from}`, '', r.text, '']),
      '## Round 3: final acceptance (verbatim)',
      '',
      ...s.accepts.flatMap((a) => [`**${a.from}:**`, '', quote(a.text), '']),
    ].join('\n'),
  );
  // The short note in the project (no transcript, data, outside paths or secrets).
  let note = null;
  const settings = readJson(SETTINGS, {});
  const notesOn = settings[s.start.project]?.notes ?? debatePolicy().projectNotes;
  if (notesOn && fs.existsSync(s.start.project)) {
    const notes = path.join(s.start.project, '.decisions');
    fs.mkdirSync(notes, { recursive: true });
    note = path.join(notes, `${date}-${slug}.md`);
    const reasons = outcome.split('\n').filter((l) => l.trim()).slice(0, 8).join('\n');
    fs.writeFileSync(note, `# ${s.start.title}\n\n${date} · decided by ${decidedBy === 'AIs' ? 'the AIs (all agreed)' : decidedBy === 'user' ? 'the user' : 'the user (pending)'} · debate ${id}\n\n${reasons}\n${opts.dissent ? `\nDissent: ${opts.dissent}\n` : ''}`);
    // Keep the notes out of normal commits (a local exclude; the shared .gitignore is untouched).
    try {
      const exclude = execFileSync('git', ['-C', s.start.project, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const current = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
      if (!/^\/?\.decisions\/?$/m.test(current)) {
        fs.mkdirSync(path.dirname(exclude), { recursive: true });
        fs.appendFileSync(exclude, `${current && !current.endsWith('\n') ? '\n' : ''}.decisions/\n`);
      }
    } catch {}
  }
  append({ from: opts.from || whoAmI(), project: s.start.project, kind: 'debate-close', debate: id, decidedBy, record, note, summary: outcome.split('\n')[0].slice(0, 200) });
  console.log(`Closed debate ${id}. Full record: ${record}${note ? `\nNote in the project: ${path.relative(s.start.project, note)}` : ''}`);
}

function listCommand(opts) {
  const project = opts.project ? projectKey(path.resolve(opts.project)) : null;
  const events = readAll();
  const repeatDays = debatePolicy().repeatDays;
  const cutoff = Date.now() - repeatDays * 864e5;
  const starts = events.filter((e) => e.kind === 'debate' && (!project || e.project === project)).slice(-30).reverse();
  if (!starts.length) return console.log('No debates yet.');
  for (const d of starts) {
    const close = events.find((e) => e.kind === 'debate-close' && e.debate === d.id);
    console.log(`${d.id}  ${day(d.at)}  ${close ? `decided by ${close.decidedBy}: ${close.summary}` : 'open'}  "${d.title}"${d.at > cutoff ? '' : '  (older than ${repeatDays} days)'}`);
  }
}

function notesCommand(opts) {
  const folder = path.resolve(opts._[1] || die('which project?'));
  const value = opts._[2];
  if (!['on', 'off'].includes(value)) die('notes on or off');
  const settings = readJson(SETTINGS, {});
  settings[projectKey(folder)] = { ...(settings[projectKey(folder)] || {}), notes: value === 'on' };
  fs.mkdirSync(DECISIONS, { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
  console.log(`Decision notes are ${value} for ${projectKey(folder)}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const opts = args(process.argv.slice(2));
  const commands = { start: startCommand, codex: codexCommand, submit: submitCommand, status: statusCommand, close: closeCommand, list: listCommand, notes: notesCommand };
  const command = commands[opts._[0]];
  if (!command) die('use start, codex, submit, status, close, list or notes (see the top of this file)');
  command(opts);
}
