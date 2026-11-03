#!/usr/bin/env node
// Claude Code hook for the message board. Reads the hook event on stdin and:
// - UserPromptSubmit, PostToolUse: hands Claude new board messages from the others (the
//   other agents) in this project (once each), so it sees them between its steps;
// - Stop: if messages arrived, keeps Claude going once to answer them;
// - PreToolUse on file edits: refuses edits to files someone else has claimed.
// Prints nothing (and changes nothing) when there's nothing to say.
import fs from 'node:fs';
import path from 'node:path';
import { maybeReveal } from './debate.mjs';
import { loadPolicy } from './lib/policy.mjs';
import { claimOn, cursor, describe, fileProject, forMe, hideSealed, recordSelf, sessionLevel, inProject, joinedFolder, projectKey, readAll, setCursor, whoAmI } from './board.mjs';

const LOOKBACK_MS = 2 * 3600e3; // a new session sees the last two hours
const MAX_SHOWN = 12;

const input = await new Promise((resolve) => {
  let text = '';
  process.stdin.on('data', (d) => (text += d));
  process.stdin.on('end', () => resolve(text));
});

let event;
try {
  event = JSON.parse(input);
} catch {
  process.exit(0);
}

// A broken agents.json or policy.json: say so in one line (exit 1 is shown but never blocks).
let me, policy;
try {
  me = whoAmI();
  policy = loadPolicy();
} catch (error) {
  process.stderr.write(`council-board: ${error.message}\n`);
  process.exit(1);
}
const name = event.hook_event_name;

// Note this session's model and effort, so help requests and debates it starts carry them.
try {
  const fromTranscript = event.transcript_path ? sessionLevel(event.transcript_path) : {};
  const effort = typeof event.effort === 'string' ? event.effort : event.effort?.level || fromTranscript.effort;
  recordSelf({ model: event.model || fromTranscript.model, effort });
} catch {}
const out = (json) => process.stdout.write(JSON.stringify(json));

if (name === 'PreToolUse') {
  if (!policy.collaboration.claims) process.exit(0);
  const file = event.tool_input?.file_path || event.tool_input?.notebook_path;
  if (file) {
    // Claims are matched by full path, whatever folder either session is in.
    const full = path.resolve(event.cwd || process.cwd(), file);
    const rel = path.relative(fileProject(full), full);
    const claim = claimOn(readAll(), full);
    if (claim && claim.by !== me) {
      out({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `${rel} is claimed on the message board by ${claim.by}${claim.note ? ` (${claim.note})` : ''}. Don't edit it: ask ${claim.by} with the board's post tool, or work on something else. If ${claim.by} has clearly stopped, ask the user before releasing it with release(force).`,
        },
      });
    }
  }
  process.exit(0);
}

if (!['UserPromptSubmit', 'PostToolUse', 'Stop'].includes(name) || !event.session_id) process.exit(0);
// Delivery between steps can be turned off in the policy (agents then check the board themselves).
if (!policy.collaboration.deliverBetweenSteps) process.exit(0);

// Messages come from the project the session joined through the board tools, if any,
// otherwise from the folder it's working in.
const key = projectKey(joinedFolder() || event.cwd || process.cwd());
// BOARD_DEBUG=<file>: note which project each hook run used (for testing).
if (process.env.BOARD_DEBUG) fs.appendFileSync(process.env.BOARD_DEBUG, `${name} ${event.tool_name || ''} cwd=${event.cwd} project=${key}\n`);

const now = Date.now();
const since = cursor(event.session_id) ?? now - LOOKBACK_MS;
// The board's own tools already showed Claude what's new.
if (name === 'PostToolUse' && String(event.tool_name || '').startsWith('mcp__board__')) {
  setCursor(event.session_id, now);
  process.exit(0);
}
// Messages addressed to someone else (another Claude, or Codex) are skipped.
// A debate whose deadline passed gets revealed here, so it happens on time.
try {
  maybeReveal();
} catch {}
const fresh = hideSealed(readAll(), me).filter((e) => e.at > since && e.from !== me && forMe(e, me) && inProject(e, key));
if (!fresh.length) {
  if (since < now - LOOKBACK_MS) setCursor(event.session_id, now);
  process.exit(0);
}
// Stop: continue only for real messages (not claim notices), and at most once in a row,
// so two Claudes can't keep each other going.
if (name === 'Stop' && (event.stop_hook_active || !fresh.some((e) => ['brief', 'join', 'message'].includes(e.kind)))) process.exit(0);

const shown = fresh.slice(-MAX_SHOWN);
const text =
  `New on the message board (you are ${me}):\n\n${shown.map(describe).join('\n\n')}` +
  (fresh.length > shown.length ? `\n\n(${fresh.length - shown.length} older ones not shown; check_in shows the board.)` : '') +
  '\n\nAnswer with the board tools (post, claim, request_help) if a reply is needed; skip replies that would only acknowledge.';
setCursor(event.session_id, now);

if (name === 'Stop') out({ decision: 'block', reason: text });
else out({ hookSpecificOutput: { hookEventName: name, additionalContext: text } });
