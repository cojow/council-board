import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, fakeGit, succeeds, refuses } from './helpers.mjs';

function codexSandbox(t, options) {
  const s = sandbox(t, options);
  const bin = path.join(s.root, 'bin');
  const git = s.write(path.join(bin, 'git'), '#!/bin/sh\nexit 128\n');
  fs.chmodSync(git, 0o755);
  s.env.PATH = `${bin}${path.delimiter}${s.env.PATH}`;
  return s;
}

const launch = (s, extra = []) => s.run('codex.mjs', ['run', '--project', s.project, '--task', 'Inspect this isolated fixture.', ...extra]);
const calls = (s) => fs.existsSync(s.env.FAKE_CODEX_CALLS) ? fs.readFileSync(s.env.FAKE_CODEX_CALLS, 'utf8').trim().split('\n').map(JSON.parse) : [];
const executions = (s) => calls(s).filter((call) => call.args.includes('--json'));
const records = (s) => fs.readdirSync(path.join(s.board, 'codex/runs')).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(s.board, 'codex/runs', name), 'utf8')));
const consent = (s, answer = 'on') => succeeds(s.run('codex.mjs', ['consent', s.project, answer]));

for (const [label, policy, flags, message] of [
  ['disabled Codex', { enabled: false }, [], /Codex is turned off/],
  ['automatic use', { autoUse: false }, ['--auto'], /automatically is off/],
  ['write permission', { allowWrite: false }, ['--write'], /edits are turned off/],
]) {
  test(`codex: refuses ${label} before launching any CLI`, (t) => {
    const s = codexSandbox(t, { policy: { codex: policy } });
    refuses(launch(s, flags), message);
    assert.deepEqual(calls(s), []);
  });
}

test('codex: project consent is required even for --dry-run; off and review-only are enforced', (t) => {
  const s = codexSandbox(t);
  refuses(launch(s, ['--dry-run']), /hasn't been allowed for this project yet/);
  assert.equal(executions(s).length, 0);
  consent(s, 'off');
  refuses(launch(s), /Codex is off for this project/);
  consent(s, 'review-only');
  refuses(launch(s, ['--write']), /review-only for Codex: no edits/);
  consent(s);
  s.write(path.join(s.project, 'CLAUDE.md'), 'Codex: off\n');
  refuses(launch(s), /Codex is off for this project \(CLAUDE.md\)/);
  assert.equal(executions(s).length, 0);
});

test('codex: --dry-run validates the fake binary but never executes a task or creates a run', (t) => {
  const s = codexSandbox(t);
  consent(s);
  const result = launch(s, ['--dry-run']);
  assert.match(succeeds(result), /Dry run: Codex would read the whole folder/);
  assert.ok(calls(s).some((call) => call.args.includes('--help')));
  assert.equal(executions(s).length, 0);
  assert.equal(fs.existsSync(path.join(s.board, 'codex/runs')), false);
  assert.equal(fs.existsSync(path.join(s.board, 'events.jsonl')), false);
});

test('codex: offline fake CLI writes the JSON stream and -o message and records usage', (t) => {
  const s = codexSandbox(t);
  consent(s);
  const task = s.write(path.join(s.root, 'task.md'), 'Inspect only the temporary project.');
  const result = s.run('codex.mjs', ['run', '--project', s.project, '--task-file', task]);
  assert.match(succeeds(result), /Codex finished/);
  const [run] = records(s);
  assert.equal(run.status, 'done');
  assert.equal(run.thread, 'fake-thread');
  assert.deepEqual(run.tokens, { input: 11, output: 7 });
  assert.equal(run.lastMessage, 'Fake Codex completed the isolated task.');
  assert.equal(run.task, 'Inspect only the temporary project.');
  assert.equal(fs.readFileSync(run.lastFile, 'utf8').trim(), run.lastMessage);
  const log = fs.readFileSync(run.logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(log.at(-1).type, 'turn.completed');
  const [execution] = executions(s);
  assert.equal(execution.cwd, s.project);
  assert.ok(execution.args.includes('read-only'));
  assert.ok(execution.args.includes('sandbox_workspace_write.network_access=false'));
  const events = fs.readFileSync(path.join(s.board, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.from === 'Codex'));
});

test('codex: shell metacharacters in project, task and title stay literal arguments', (t) => {
  const s = codexSandbox(t);
  const project = path.join(s.root, 'project; $(touch INJECTED)');
  fs.mkdirSync(project);
  succeeds(s.run('codex.mjs', ['consent', project, 'on']));
  const task = 'Inspect; $(touch INJECTED) `touch INJECTED`';
  succeeds(s.run('codex.mjs', ['run', '--project', project, '--task', task, '--title', task]));
  const [execution] = executions(s);
  assert.equal(execution.cwd, project);
  assert.ok(execution.args.at(-1).endsWith(task));
  assert.equal(fs.existsSync(path.join(project, 'INJECTED')), false);
  assert.equal(fs.existsSync(path.join(s.project, 'INJECTED')), false);
});

test('codex: project symlinks are canonicalized before constructing a worktree subpath', (t) => {
  const s = codexSandbox(t);
  const alias = path.join(s.root, 'project-link');
  fs.symlinkSync(s.project, alias, 'dir');
  consent(s);
  succeeds(s.run('codex.mjs', ['run', '--project', alias, '--task', 'Inspect this fixture.']));
  assert.equal(records(s)[0].folder, fs.realpathSync(s.project));
});

test('codex: resume treats a task beginning with a dash as a positional argument', (t) => {
  const s = codexSandbox(t);
  consent(s);
  succeeds(launch(s));
  const [run] = records(s);
  const task = '--literal-task';
  succeeds(s.run('codex.mjs', ['resume', run.id, '--task', task]));
  const execution = executions(s).at(-1);
  assert.deepEqual(execution.args.slice(execution.args.indexOf('--')), ['--', run.thread, task]);
});

for (const [label, changed, context] of [
  ['parent context traversal', [], '../outside.md'],
  ['symlinked context', [], 'linked.md'],
  ['symlinked changed file', ['linked.md'], null],
]) {
  test(`codex: review rejects ${label} without copying outside the sandbox`, (t) => {
    const s = codexSandbox(t);
    const outside = s.write(path.join(s.root, 'outside.md'), 'Outside project: do not copy.');
    fs.symlinkSync(outside, path.join(s.project, 'linked.md'));
    fakeGit(s, { changed });
    consent(s);
    refuses(launch(s, ['--review', '--dry-run', ...(context ? ['--context', context] : [])]), /outside the project/);
    assert.equal(executions(s).length, 0);
    assert.deepEqual(fs.readdirSync(s.tmp), [], 'dry-run temp sandbox is cleaned even on rejection');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'Outside project: do not copy.');
  });
}

test('codex: review includes code and lists data and secrets without copying them', (t) => {
  const s = codexSandbox(t);
  s.write(path.join(s.project, 'code.mjs'), 'export const answer = 42;\n');
  s.write(path.join(s.project, 'measurements.csv'), 'value\n42\n');
  s.write(path.join(s.project, '.env'), 'PRIVATE_VALUE=withheld\n');
  fakeGit(s, { changed: ['code.mjs', 'measurements.csv', '.env'] });
  consent(s);
  succeeds(launch(s, ['--review']));
  const [run] = records(s);
  assert.deepEqual(run.reviewed.code, ['code.mjs']);
  assert.match(run.reviewed.data[0], /measurements.csv/);
  assert.deepEqual(run.reviewed.withheld, ['.env']);
  assert.equal(fs.existsSync(path.join(run.dir, 'code.mjs')), true);
  assert.equal(fs.existsSync(path.join(run.dir, 'measurements.csv')), false);
  assert.equal(fs.existsSync(path.join(run.dir, '.env')), false);
  assert.match(fs.readFileSync(path.join(run.dir, 'DATA_FILES.txt'), 'utf8'), /measurements.csv/);
  assert.match(fs.readFileSync(path.join(run.dir, 'WITHHELD.txt'), 'utf8'), /\.env/);
});

for (const deleted of [false, true]) {
  test(`codex: review rejects credentials in the old diff of a ${deleted ? 'deleted' : 'redacted'} file`, (t) => {
    const s = codexSandbox(t);
    if (!deleted) s.write(path.join(s.project, 'code.mjs'), 'export const answer = 42;\n');
    const token = 'sk-' + 'SyntheticToken0123456789'.repeat(2);
    fakeGit(s, { changed: ['code.mjs'], diff: `-const token = "${token}";\n+export const answer = 42;\n` });
    consent(s);
    refuses(launch(s, ['--review', '--dry-run']), /review diff may contain credentials.*removed lines/);
    assert.equal(executions(s).length, 0);
    assert.deepEqual(fs.readdirSync(s.tmp), []);
  });
}

for (const [label, policy, extra, message] of [
  ['disabled Codex', { enabled: false }, {}, /Codex is turned off/],
  ['revoked automatic use', { autoUse: false }, { auto: true }, /automatically is off/],
  ['revoked edits', { allowWrite: false }, { write: true }, /edits are turned off/],
]) {
  test(`codex: resume respects ${label}`, (t) => {
    const s = codexSandbox(t);
    consent(s);
    succeeds(launch(s));
    const [run] = records(s);
    s.json(path.join(s.board, 'codex/runs', `${run.id}.json`), { ...run, ...extra });
    s.json(path.join(s.board, 'policy.json'), { codex: policy });
    refuses(s.run('codex.mjs', ['resume', run.id, '--task', 'Continue.']), message);
    assert.equal(executions(s).length, 1);
  });
}
