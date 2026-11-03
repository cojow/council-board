#!/usr/bin/env node
// The message board as tools Claude can use (an MCP server over stdio, no dependencies).
// Each Claude agent runs its own copy; they share the board through the event log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { debateState, maybeReveal, submitTurn } from './debate.mjs';
import { fileURLToPath } from 'node:url';
import { loadAgents } from './lib/config.mjs';
import { houseRules, loadPolicy, renderInstructions } from './lib/policy.mjs';
import { append, claimOn, claims, clearJoined, compact, describe, forMe, hideSealed, inProject, selfLevel, openBriefs, projectKey, readAll, setJoined, whoAmI } from './board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const me = whoAmI();
const startFolder = process.env.CLAUDE_PROJECT_DIR || process.cwd();
// The project this session works in: where it started, unless a tool's project option or
// offer_help moved it (remembered for later calls, and shared with the hook).
let folder = startFolder;
let seen = Date.now(); // newest event this session has been shown (for wait_for_messages)

function useProject(target) {
  const resolved = path.resolve(folder, String(target).replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error(`No such folder: ${resolved}`);
  folder = resolved;
  if (projectKey(folder) === projectKey(startFolder)) clearJoined(process.ppid);
  else setJoined(process.ppid, folder);
}
const leave = () => clearJoined(process.ppid);
process.on('exit', leave);
process.stdin.on('end', () => process.exit(0));

// The instructions every agent gets: generated from the policy and agents config, plus the
// user's optional house rules (guidance only).
const policy = loadPolicy();
const agentsConfig = loadAgents() || { agents: [], groupName: 'the board' };
const INSTRUCTIONS = renderInstructions({ me, agents: agentsConfig.agents, groupName: agentsConfig.groupName, policy, boardDir: HERE, houseRules: houseRules() });
const names = agentsConfig.agents.map((a) => `'${a.name}'`).join(', ');

const S = { type: 'string' };
const PROJECT = { type: 'string', description: "Only to work on a different project than the current one: its folder. Leave it out otherwise. Remembered for later calls." };
const TOOLS = [
  { name: 'check_in', description: "See this project's board: open help requests, recent messages and claimed files.", inputSchema: { type: 'object', properties: {} } },
  {
    name: 'request_help',
    description: 'Ask another agent to help with part of your current task. Write a brief it can act on without asking the user.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { ...S, description: 'The overall task' },
        done_so_far: { ...S, description: "What's already done or decided" },
        help_with: { ...S, description: 'Exactly what another agent should do, and what you will do yourself' },
        files: { type: 'array', items: S, description: 'Files involved (relative to the project)' },
        notes: { ...S, description: 'Conventions, commands to run, things to avoid' },
        to: { ...S, description: `Who it's for (one of ${names}); leave out for anyone` },
        start_helper: { type: 'boolean', description: 'Ask an app that can start helper sessions to start one for this (default true; only does something if the user set such an app up)' },
      },
      required: ['goal', 'help_with'],
    },
  },
  { name: 'offer_help', description: "Join another agent's work in this project: returns its help request (or asks for one), recent messages and claimed files.", inputSchema: { type: 'object', properties: { note: { ...S, description: 'Optional note to another agent' } } } },
  { name: 'post', description: 'Post a message to the others on the board about this project (status, question, answer, summary).', inputSchema: { type: 'object', properties: { text: S, to: { ...S, description: `Optional: only for one of them (${names})` }, everywhere: { type: 'boolean', description: 'Post to all projects instead of this one' } }, required: ['text'] } },
  { name: 'wait_for_messages', description: 'Wait for new board messages from another agent in this project (up to 4 minutes per call).', inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: 'How long to wait (default 90, max 240)' } } } },
  { name: 'claim', description: "Claim files you're about to edit so another agent leaves them alone (claims expire after 2 hours).", inputSchema: { type: 'object', properties: { files: { type: 'array', items: S }, note: S }, required: ['files'] } },
  { name: 'release', description: 'Release files you claimed (or all of yours). force releases another Claude\'s claim; use only if the user says so or it has clearly stopped.', inputSchema: { type: 'object', properties: { files: { type: 'array', items: S }, all: { type: 'boolean' }, force: { type: 'boolean' } } } },
  {
    name: 'debate_submit',
    description: "Take your turn in a debate (DEBATE-POLICY.md). Round 1: your own independent view, at most 350 words, with a confidence 0-1; it stays sealed until everyone has answered. Round 2: one critique, at most 200 words, answering the strongest opposing argument. Round 3: start with AGREED or 'OBJECTION: <change and why>', plus your confidence in the merged answer.",
    inputSchema: { type: 'object', properties: { debate: { ...S, description: 'The debate id' }, round: { type: 'number', description: '1, 2 or 3' }, text: S, confidence: { type: 'number', description: '0 to 1' } }, required: ['debate', 'round', 'text'] },
  },
  { name: 'debate_status', description: 'See where a debate stands: who has answered each round, and the revealed views and replies.', inputSchema: { type: 'object', properties: { debate: S }, required: ['debate'] } },
  { name: 'close_request', description: 'Close your open help request(s) in this project when the shared work is done.', inputSchema: { type: 'object', properties: { summary: S } } },
];

// Every tool takes the project option.
for (const t of TOOLS) t.inputSchema.properties.project = PROJECT;

const key = () => projectKey(folder);
const rel = (f) => path.relative(key(), path.resolve(folder, f)) || f;
// Open help requests from another agent in projects other than this one, newest first.
const requestsElsewhere = (events) => {
  const closed = new Set(events.filter((e) => e.kind === 'brief-closed').map((e) => e.brief));
  return events.filter((e) => e.kind === 'brief' && e.from !== me && forMe(e, me) && !closed.has(e.id) && Date.now() - e.at < 12 * 3600e3 && !inProject(e, key())).reverse();
};
// The board as this Claude may see it: sealed debate views held back until their reveal.
const visible = () => {
  try {
    maybeReveal();
  } catch {}
  return hideSealed(readAll(), me);
};
const fromOthers = (events) => events.filter((e) => e.from !== me && forMe(e, me) && inProject(e, key()));

function overview(events) {
  const k = key();
  const briefs = openBriefs(events, k);
  const recent = events.filter((e) => inProject(e, k) && e.kind !== 'brief').slice(-15);
  const held = [...claims(events, k)].map(([f, c]) => `${f} — ${c.by}${c.note ? ` (${c.note})` : ''}`);
  return [
    `Project: ${k}`,
    briefs.length ? `Open help requests:\n${briefs.map(describe).join('\n\n')}` : 'Open help requests: none',
    `Claimed files: ${held.length ? `\n${held.join('\n')}` : 'none'}`,
    `Recent messages:\n${recent.length ? recent.map(describe).join('\n') : '(none)'}`,
  ].join('\n\n');
}

async function call(name, args = {}) {
  // A project naming the folder the session started in is the default, not a choice.
  const chosen = args.project && projectKey(path.resolve(folder, String(args.project).replace(/^~(?=\/|$)/, os.homedir()))) !== projectKey(startFolder);
  if (args.project) useProject(args.project);
  // offer_help without a chosen project: follow another agent's request if it's in
  // exactly one other project.
  let moved = '';
  if (name === 'offer_help' && !chosen && !openBriefs(readAll(), key()).some((b) => b.from !== me && forMe(b, me))) {
    const projects = [...new Set(requestsElsewhere(readAll()).map((e) => e.project))];
    if (projects.length === 1) {
      useProject(projects[0]);
      moved = `Switched to ${projects[0]}, where another agent asked for help (this session started in ${startFolder}). Board tools, incoming messages and file claims now use that project.\n\n`;
    }
  }
  const k = key();
  const base = { from: me, project: k };
  switch (name) {
    case 'check_in': {
      const events = visible();
      seen = Math.max(seen, ...events.map((e) => e.at));
      const elsewhere = requestsElsewhere(events);
      return overview(events) + (elsewhere.length ? `\n\nOpen help requests from other agents in other projects: ${[...new Set(elsewhere.map((e) => e.project))].join(', ')} (use the project option to work there).` : '');
    }
    case 'request_help': {
      const e = append({ ...base, kind: 'brief', to: args.to || undefined, ...(selfLevel() || {}), goal: args.goal, done: args.done_so_far || '', helpWith: args.help_with, files: (args.files || []).map(rel), text: args.notes || '', wake: args.start_helper !== false });
      const wake =
        args.start_helper === false
          ? 'The other agent sees it when the user tells it to help (/help-out), or at its next step if it is already working here.'
          : "If the user set up an app that starts helper sessions, a 'started a helper session' notice arrives here shortly; otherwise tell the user to run /help-out in the other agent.";
      return `Posted help request ${e.id}. ${wake} Keep working on your part; another agent's messages reach you between your steps.`;
    }
    case 'offer_help': {
      append({ ...base, kind: 'join', text: args.note || '' });
      const events = visible();
      seen = Math.max(seen, ...events.map((e) => e.at));
      const briefs = openBriefs(events, k).filter((b) => b.from !== me && forMe(b, me));
      if (!briefs.length) {
        // Requests in several other projects: let Claude pick (the user's words or the newest).
        const elsewhere = [...new Set(requestsElsewhere(events).map((e) => e.project))];
        const hint = elsewhere.length > 1 ? `\n\nThe other Claude has open help requests in several other projects (newest first): ${elsewhere.join(', ')}. If one of those is what the user meant, call offer_help again with project set to it.` : '';
        append({ ...base, kind: 'message', text: `I'm ready to help in this project. Please post a help request (request_help) saying which part I should take.` });
        return `${moved}${overview(events)}\n\nNo help request from another agent here yet. I've asked it for one; call wait_for_messages to wait for its answer (it sees the board between its own steps, or when the user next talks to it).${hint}`;
      }
      return `${moved}${overview(events)}\n\nTake the newest help request above. Claim files before editing them, post status as you go, and post a summary when your part is done.`;
    }
    case 'post':
      append({ ...base, kind: 'message', to: args.to || undefined, text: String(args.text || ''), everywhere: Boolean(args.everywhere) });
      return 'Posted.';
    case 'wait_for_messages': {
      const end = Date.now() + Math.min(240, Math.max(5, Number(args.seconds) || 90)) * 1000;
      while (Date.now() < end) {
        const fresh = fromOthers(visible()).filter((e) => e.at > seen);
        if (fresh.length) {
          seen = Math.max(...fresh.map((e) => e.at));
          return fresh.map(describe).join('\n\n');
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      return 'No new messages yet. Keep working on your part, or wait again.';
    }
    case 'claim': {
      const files = (args.files || []).map(rel);
      // By full path, so a claim made from another folder (a parent or the repo) counts.
      const events = readAll();
      const holder = (f) => claimOn(events, path.resolve(k, f));
      const taken = files.filter((f) => holder(f) && holder(f).by !== me);
      if (taken.length) return `Not claimed: ${taken.map((f) => `${f} (held by ${holder(f).by}${holder(f).note ? `: ${holder(f).note}` : ''})`).join(', ')}. Ask on the board before touching these.`;
      append({ ...base, kind: 'claim', files, text: args.note || '' });
      return `Claimed ${files.join(', ')}.`;
    }
    case 'release':
      if (args.all) append({ ...base, kind: 'release-all' });
      else append({ ...base, kind: 'release', files: (args.files || []).map(rel), force: Boolean(args.force) });
      return 'Released.';
    case 'debate_submit': {
      submitTurn(String(args.debate), Number(args.round), { from: me, text: args.text, confidence: args.confidence });
      const s = debateState(String(args.debate));
      return Number(args.round) === 1
        ? `Your round-1 view is sealed. ${s.reveal ? 'Everyone has answered: round 1 is revealed now (debate_status shows it).' : 'It opens when everyone has answered or at the deadline; wait for the reveal (wait_for_messages).'}`
        : `Recorded your round-${args.round} turn.`;
    }
    case 'debate_status': {
      maybeReveal();
      const s = debateState(String(args.debate));
      if (!s) return `No debate ${args.debate}.`;
      const views = s.reveal ? s.reveal.views.map((v) => `=== ${v.from} (round 1, confidence ${v.confidence ?? '?'}) ===\n${v.text}`).join('\n\n') : `Round 1 sealed; answered so far: ${s.views.map((v) => v.from).join(', ') || 'nobody'}.`;
      return [`Debate ${s.start.id}: "${s.start.title}" (${s.start.participants.join(', ')})`, s.start.question, views, ...s.replies.map((r) => `=== ${r.from} (round 2) ===\n${r.text}`), ...s.accepts.map((a) => `${a.from} (round 3): ${a.text}`), s.close ? `Closed, decided by ${s.close.decidedBy}.` : ''].filter(Boolean).join('\n\n');
    }
    case 'close_request': {
      const mine = openBriefs(readAll(), k).filter((b) => b.from === me);
      for (const b of mine) append({ ...base, kind: 'brief-closed', brief: b.id, text: args.summary || '' });
      append({ ...base, kind: 'release-all' });
      return mine.length ? `Closed ${mine.length} help request(s) and released your files.` : 'You have no open help requests here.';
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---------- MCP over stdio (newline-delimited JSON-RPC) ----------

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  try {
    if (method === 'initialize') {
      compact();
      send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'board', version: '1.0.0' }, instructions: INSTRUCTIONS } });
    } else if (method === 'tools/list') send({ id, result: { tools: TOOLS } });
    else if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: await call(params.name, params.arguments) }] } });
    else if (method === 'ping') send({ id, result: {} });
    else send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
  } catch (error) {
    if (method === 'tools/call') send({ id, result: { content: [{ type: 'text', text: String(error.message || error) }], isError: true } });
    else send({ id, error: { code: -32603, message: String(error.message || error) } });
  }
});
