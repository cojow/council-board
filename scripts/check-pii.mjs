#!/usr/bin/env node
// Local, dependency-free prepublication check. Diagnostics omit the matched value so
// a detected secret is not copied into CI logs. Add a trailing comment `pii-ok: why`
// for an intentional example, or put private extra terms in .pii-denylist (gitignored).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 10000 });
let root = process.cwd();
let files;
let tracked = false;
try {
  root = git(['rev-parse', '--show-toplevel']).trim();
  files = git(['-C', root, 'ls-files', '-z']).split('\0').filter(Boolean);
  tracked = true;
} catch {
  files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(root, full));
    }
  };
  walk(root);
}

const denyFile = '.pii-denylist';
let deny = [];
try {
  deny = fs.readFileSync(path.join(root, denyFile), 'utf8').split(/\r?\n/).map((word) => word.trim().toLowerCase()).filter((word) => word && !word.startsWith('#'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

// Accept comment syntax used by JS, YAML/shell/Python, CSS and Markdown. A bare
// occurrence of the marker inside text does not suppress the line.
const suppressed = (line) => /(?:\/\/|#)\s*pii-ok\b(?:\s*:[^\r\n]*)?\s*$|\/\*\s*pii-ok\b(?:\s*:[^\r\n]*?)?\s*\*\/\s*$|<!--\s*pii-ok\b(?:\s*:[^\r\n]*?)?\s*-->\s*$/i.test(line);
const entropy = (value) => {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum - count / value.length * Math.log2(count / value.length), 0);
};

function allowedEmail(email) {
  const lower = email.toLowerCase();
  const domain = lower.split('@')[1];
  return lower === 'noreply@anthropic.com' || domain === 'users.noreply.github.com' || /^(?:[\w-]+\.)*example\.(?:com|org)$/.test(domain);
}

function allowedIP(ip) {
  const lower = ip.toLowerCase().split('%')[0];
  if (isIP(lower) === 4) {
    return lower === '127.0.0.1' || lower === '0.0.0.0' || /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(lower);
  }
  // IPv6 loopback/unspecified and the documentation prefixes, including expanded forms.
  const parts = lower.split('::');
  const left = parts[0].split(':').filter(Boolean);
  const right = (parts[1] || '').split(':').filter(Boolean);
  const groups = parts.length === 2 ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  const nums = groups.map((group) => parseInt(group, 16));
  return nums.length === 8 && (
    nums.slice(0, 7).every((n) => n === 0) && (nums[7] === 0 || nums[7] === 1) ||
    nums[0] === 0x2001 && nums[1] === 0x0db8 ||
    nums[0] === 0x3fff && nums[1] <= 0x0fff
  );
}

function reasons(line) {
  if (suppressed(line)) return [];
  const hits = new Set();
  for (const match of line.matchAll(/\/(Users|home)\/([^/\s"'`\\()[\]{}<>;:,]+)/g)) {
    const [, base, name] = match;
    if (name !== 'you' && !(base === 'Users' && name === 'example')) hits.add('absolute personal home path');
  }
  for (const [email] of line.matchAll(/[A-Z0-9][A-Z0-9.!#$%&'*+/=?^_`{|}~-]*@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi)) {
    if (!allowedEmail(email)) hits.add('email address');
  }
  // ISO dates and version numbers next to each other ("0.1.0 (2026-11-03)") look like phone numbers.
  const forPhones = line.replace(/(?<![\w.])\d{4}-\d{2}-\d{2}(?![\w.])/g, ' ').replace(/(?<![\w.])v?\d+(?:\.\d+){2,}(?![\w.])/g, ' ');
  const phones = [
    ...forPhones.matchAll(/(?<![\w.])(?:\+?\d[\d(). \t-]{7,}\d)(?![\w.])/g),
    ...forPhones.matchAll(/(?<![\w.])(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}(?![\w.])/g),
  ];
  for (const [phone] of phones) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) continue;
    if (/^\d{4}-\d{2}-\d{2}(?:\D|$)/.test(phone) || isIP(phone)) continue;
    if (/^\d+$/.test(phone) && digits.length !== 10) continue; // timestamps, sizes, counters
    hits.add('phone number');
  }
  const ips = [
    ...line.matchAll(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g),
    ...line.matchAll(/(?<![\w:])(?:[\da-f]{0,4}:){2,}[\da-f:.]*(?:%[\w.-]+)?(?![\w:])/gi),
  ];
  for (const [ip] of ips) if (isIP(ip.split('%')[0]) && !allowedIP(ip)) hits.add('non-documentation IP address');
  if (/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,})\b/.test(line)) hits.add('likely API key or token');
  for (const [hex] of line.matchAll(/\b[a-f\d]{32,}\b/gi)) if (entropy(hex.toLowerCase()) >= 3) hits.add('long hexadecimal secret');
  for (const [token] of line.matchAll(/(?<![\w+/=-])[A-Za-z0-9+/_-]{40,}={0,2}(?![\w+/=-])/g)) {
    // Standard base64 and base64url use different alphabets; mixing them is often a path.
    if (/[+/]/.test(token) && /[-_]/.test(token)) continue;
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && entropy(token) >= 4) hits.add('long base64-like secret');
  }
  const lower = line.toLowerCase();
  if (deny.some((word) => lower.includes(word))) hits.add('private deny-list term');
  return [...hits];
}

let hits = 0;
const report = (file, line, reason) => {
  // JSON escaping prevents control characters in file names from forging log lines.
  const label = /[\x00-\x1f\x7f]/.test(file) ? JSON.stringify(file) : file;
  console.error(`${label}:${line}: ${reason}`);
  hits++;
};
for (const file of [...new Set(files)].sort()) {
  if (file === denyFile) {
    if (tracked) report(file, 1, 'personal deny-list must stay untracked');
    continue;
  }
  const full = path.resolve(root, file);
  const relative = path.relative(root, full);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    report(file, 1, 'file path escapes scan root');
    continue;
  }
  let text;
  try {
    // Git tracks the link target itself, never the contents of an external target.
    const stat = fs.lstatSync(full);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    text = stat.isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') continue; // tracked file deleted in the working tree
    report(file, 1, `cannot read file (${error.code || 'unknown error'})`);
    continue;
  }
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    for (const reason of reasons(line)) report(file, index + 1, reason);
  }
}
if (hits) {
  console.error(`PII scan failed: ${hits} finding(s). Remove private data or add a trailing pii-ok comment for an intentional example.`);
  process.exitCode = 1;
} else console.log(`PII scan passed (${new Set(files).size} files checked).`);
