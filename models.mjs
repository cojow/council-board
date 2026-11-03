// Which Codex model and reasoning effort match a Claude model and effort, so a helper
// works at the level of the AI that asked for help.
//
// The mapping (researched 2026-10-26; change it here as the lineups change):
//   Claude tier   Codex model                                   effort
//   Opus          GPT-6 Astra if this Codex offers it           same level
//                 otherwise GPT-6.1 Sol (the best it offers)    one level up
//   Sonnet        GPT-6.1 Sol                                   same level
//   Haiku         GPT-6 Luna                                    one level up
// Why: on the Artificial Analysis Intelligence Index, Opus 5.5 scores 51 at medium effort and
// 58 at max, against 48 and 52 for GPT-6.1 Sol. Sol is OpenAI's workhorse, not its flagship
// (Astra), and isn't in this Codex's model list. So Sol stands in for Opus one effort level up.
// Sonnet 5.5 (56 at max) is closest to Sol. Haiku 5.5 (43 at max) is ahead of Luna (38 at max),
// so Luna also goes one level up. Effort names match on both sides (low, medium, high, xhigh,
// max); OpenAI's "ultra" (which uses sub-agents) is never chosen. Unknown or "auto" effort maps
// to the Claude default for Code sessions, high.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BOARD_DIR } from './board.mjs';

export const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const CATALOG = path.join(BOARD_DIR, 'codex', 'models.json');

// The models this Codex offers, cached for a day (codex debug models).
function catalog(bin) {
  try {
    const cached = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
    if (Date.now() - cached.at < 864e5) return cached.slugs;
  } catch {}
  try {
    const raw = JSON.parse(execFileSync(bin, ['debug', 'models'], { encoding: 'utf8', timeout: 20000 }));
    const list = Array.isArray(raw) ? raw : raw.models || [];
    const slugs = list.map((m) => m.slug).filter(Boolean);
    fs.mkdirSync(path.dirname(CATALOG), { recursive: true });
    fs.writeFileSync(CATALOG, JSON.stringify({ at: Date.now(), slugs }));
    return slugs;
  } catch {
    return [];
  }
}

const tierOf = (model) => (/opus/i.test(model || '') ? 'opus' : /sonnet/i.test(model || '') ? 'sonnet' : /haiku/i.test(model || '') ? 'haiku' : null);
const step = (effort, by) => LADDER[Math.min(LADDER.length - 1, Math.max(0, LADDER.indexOf(effort) + by))];

// { model, effort } for Codex to match a Claude { model, effort }; null when there's
// nothing to match (no requester known), so Codex keeps its own defaults.
export function codexMatch(claude, bin) {
  const tier = tierOf(claude?.model);
  if (!tier) return null;
  const effort = LADDER.includes(claude.effort) ? claude.effort : 'high';
  const offered = catalog(bin);
  const has = (slug) => !offered.length || offered.includes(slug);
  if (tier === 'opus') {
    const astra = offered.find((s) => /astra/i.test(s));
    return astra
      ? { model: astra, effort, why: `matches ${claude.model} at ${effort}` }
      : { model: 'gpt-6.1-sol', effort: step(effort, 1), why: `GPT-6.1 Sol one level up stands in for ${claude.model} at ${effort} (GPT-6 Astra isn't offered here)` };
  }
  if (tier === 'sonnet') return { model: has('gpt-6.1-sol') ? 'gpt-6.1-sol' : 'gpt-6-sol', effort, why: `matches ${claude.model} at ${effort}` };
  return { model: has('gpt-6-luna') ? 'gpt-6-luna' : 'gpt-5.6-luna', effort: step(effort, 1), why: `Luna one level up matches ${claude.model} at ${effort}` };
}

// A short label for posts: "claude-opus-5-5 · high".
export const label = (m) => (m?.model ? `${m.model}${m.effort ? ` · ${m.effort}` : ''}` : 'unknown');
