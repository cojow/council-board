import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeGit, succeeds } from './helpers.mjs';

const personalEmail = ['maintainer', 'private.invalid'].join('@');
const privatePath = (base, name) => `/${base}/${name}/project`;
const scan = (s) => s.run('scripts/check-pii.mjs');

for (const [name, value, reason] of [
  ['macOS home', privatePath('Users', 'sample-person'), 'absolute personal home path'],
  ['Linux home', privatePath('home', 'sample-person'), 'absolute personal home path'],
  ['email', personalEmail, 'email address'],
  ['US phone', ['202', '555', '0142'].join('-'), 'phone number'],
  ['international phone', ['+44', '20', '7946', '0958'].join(' '), 'phone number'],
  ['plain phone', ['202', '555', '0142'].join(''), 'phone number'],
  ['public IPv4', [8, 8, 4, 4].join('.'), 'non-documentation IP address'],
  ['private IPv4', [10, 20, 30, 40].join('.'), 'non-documentation IP address'],
  ['IPv6', ['2606', '4700', '4700', '', '1111'].join(':'), 'non-documentation IP address'],
  ['OpenAI token', 'sk-' + 'SyntheticToken0123456789'.repeat(2), 'likely API key or token'],
  ['GitHub token', 'ghp_' + 'SyntheticToken0123456789'.repeat(2), 'likely API key or token'],
  ['AWS key', 'AKIA' + 'SYNTHETI01234567', 'likely API key or token'],
  ['hex secret', ['0123456789abcdef', 'fedcba9876543210'].join(''), 'long hexadecimal secret'],
  ['base64 secret', Buffer.from('Deterministic synthetic token material: 9876543210.').toString('base64'), 'long base64-like secret'],
  ['base64 secret starting with a slash', '/' + Buffer.from('Synthetic token material with 9876543210.').toString('base64'), 'long base64-like secret'],
  ['multiple phone numbers on one line', ['202', '555', '0142'].join('-') + ' ' + ['303', '555', '0143'].join('-'), 'phone number'],
]) {
  test(`PII scanner: detects ${name} with a file and line, without echoing the value`, (t) => {
    const s = sandbox(t);
    s.write(path.join(s.project, 'sample.txt'), `safe heading\n${value}\n`);
    const result = scan(s);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(`sample.txt:2: ${reason}`), result.stderr);
    assert.equal(result.stderr.includes(value), false, 'diagnostic must not disclose the secret');
  });
}

test('PII scanner: allows documented home, email and IP examples', (t) => {
  const s = sandbox(t);
  const safe = [
    privatePath('Users', 'you'), privatePath('home', 'you'), privatePath('Users', 'example'),
    'noreply@anthropic.com', '123+bot@users.noreply.github.com', 'reader@example.com', 'reader@example.org',
    "'noreply@anthropic.com'", '"reader@example.org"',
    '127.0.0.1', '0.0.0.0', '192.0.2.42', '198.51.100.8', '203.0.113.10',
    '::1', '::', '2001:db8::42', '2001:0db8:0:0:0:0:0:42', '3fff:123::1',
    '2026-11-03', '## 0.1.0 (2026-11-03)', 'v1.2.3 2026-11-03', '1793720000000', '0'.repeat(64),
  ];
  s.write(path.join(s.project, 'examples.txt'), safe.join('\n'));
  assert.match(succeeds(scan(s)), /PII scan passed/);
});

for (const suffix of ['// pii-ok', '# pii-ok: synthetic example', '/* pii-ok */', '<!-- pii-ok: example -->']) {
  test(`PII scanner: accepts trailing suppression ${suffix}`, (t) => {
    const s = sandbox(t);
    s.write(path.join(s.project, 'sample.txt'), `${personalEmail} ${suffix}\n`);
    succeeds(scan(s));
  });
}

test('PII scanner: a bare or non-trailing marker does not hide findings', (t) => {
  const s = sandbox(t);
  s.write(path.join(s.project, 'sample.txt'), `pii-ok ${personalEmail}\n${personalEmail} pii-ok\n// pii-ok\n${personalEmail}\n`);
  const result = scan(s);
  assert.equal(result.status, 1);
  for (const line of [1, 2, 4]) assert.ok(result.stderr.includes(`sample.txt:${line}: email address`));
});

test('PII scanner: deny-list is optional, literal, case-insensitive and never printed or scanned', (t) => {
  const s = sandbox(t);
  s.write(path.join(s.project, '.pii-denylist'), '\n# private terms\nSynthetic.Maintainer\nPrivate School\n');
  s.write(path.join(s.project, 'sample.txt'), 'Meet SYNTHETIC.MAINTAINER from PRIVATE SCHOOL.\n');
  const result = scan(s);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /sample.txt:1: private deny-list term/);
  assert.doesNotMatch(result.stderr, /Synthetic|Maintainer|School|\.pii-denylist:/i);
  s.write(path.join(s.project, 'sample.txt'), 'SyntheticXMaintainer\n');
  succeeds(scan(s));
});

test('PII scanner: fallback walks nested files, skips .git/node_modules, and scans link text only', (t) => {
  const s = sandbox(t);
  s.write(path.join(s.project, '.git/hidden.txt'), personalEmail);
  s.write(path.join(s.project, 'node_modules/hidden.txt'), personalEmail);
  const outside = s.write(path.join(s.root, 'outside.txt'), personalEmail);
  fs.symlinkSync(outside, path.join(s.project, 'linked.txt'));
  succeeds(scan(s));
  s.write(path.join(s.project, 'nested/visible.txt'), personalEmail);
  const result = scan(s);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nested\/visible.txt:1: email address/);
  assert.doesNotMatch(result.stderr, /hidden.txt|linked.txt/);
});

test('PII scanner: Git mode scans only tracked files, including paths with spaces and symlink targets', (t) => {
  const s = sandbox(t);
  fakeGit(s, { tracked: ['tracked file.txt', 'missing.txt', 'personal-link'] });
  s.write(path.join(s.project, 'untracked.txt'), personalEmail);
  s.write(path.join(s.project, 'tracked file.txt'), 'safe\n');
  fs.symlinkSync(privatePath('Users', 'sample-person'), path.join(s.project, 'personal-link'));
  let result = scan(s);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /personal-link:1: absolute personal home path/);
  assert.doesNotMatch(result.stderr, /untracked|missing/);
  fs.rmSync(path.join(s.project, 'personal-link'));
  succeeds(scan(s));
  s.write(path.join(s.project, 'tracked file.txt'), personalEmail);
  result = scan(s);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tracked file.txt:1: email address/);
});

test('PII scanner: accidentally tracked deny-list is rejected without exposing its contents', (t) => {
  const s = sandbox(t);
  fakeGit(s, { tracked: ['.pii-denylist'] });
  s.write(path.join(s.project, '.pii-denylist'), 'Synthetic Maintainer\n');
  const result = scan(s);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /\.pii-denylist:1: personal deny-list must stay untracked/);
  assert.doesNotMatch(result.stderr, /Synthetic Maintainer/);
});
