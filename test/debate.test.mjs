import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, succeeds, refuses } from './helpers.mjs';

function start(s, extra = []) {
  const question = s.write(path.join(s.root, 'question.md'), 'Which reversible option fits the task?');
  const view = s.write(path.join(s.root, 'view.md'), 'Prefer the smaller option.');
  return s.run('debate.mjs', ['start', '--project', s.project, '--title', 'Test decision', '--question-file', question, '--view-file', view, '--participants', 'Alpha Claude,Beta Claude', ...extra]);
}

test('debate: disabled debates refuse a start without writing events', (t) => {
  const s = sandbox(t, { policy: { debates: { enabled: false } } });
  refuses(start(s), /debates are turned off in policy.json/);
  assert.equal(fs.existsSync(path.join(s.board, 'events.jsonl')), false);
});

test('debate: --auto requires selfStarted; explicit starts remain available', (t) => {
  const s = sandbox(t);
  refuses(start(s, ['--auto']), /self-started debates are off/);
  assert.equal(fs.existsSync(path.join(s.board, 'events.jsonl')), false);
  assert.match(succeeds(start(s)), /Started debate/);
});

test('debate: exact word limits are enforced in all three rounds and first views stay sealed', (t) => {
  const s = sandbox(t);
  succeeds(start(s));
  const events = () => fs.readFileSync(path.join(s.board, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const id = events().find((event) => event.kind === 'debate').id;
  assert.equal(events().some((event) => event.kind === 'debate-reveal'), false);
  const invalid = s.write(path.join(s.root, 'invalid.md'), 'AGREED');
  refuses(s.run('debate.mjs', ['submit', id, '4', '--file', invalid]), /round must be 1, 2 or 3/);
  for (const [round, limit] of [[1, 350], [2, 200], [3, 80]]) {
    const words = (count) => [round === 3 ? 'AGREED' : 'View', ...Array(count - 1).fill('word')].join(' ');
    const file = s.write(path.join(s.root, `round-${round}.md`), words(limit + 1));
    const submit = () => s.run('debate.mjs', ['submit', id, String(round), '--file', file], { env: { BOARD_AGENT: 'beta' } });
    const before = events().length;
    refuses(submit(), new RegExp(`round ${round} turns are at most ${limit} words.*${limit + 1}`));
    assert.equal(events().length, before, 'rejected turns do not write events');
    s.write(file, words(limit));
    assert.match(succeeds(submit()), new RegExp(`Recorded your round-${round} turn`));
    if (round === 1) {
      const reveal = events().find((event) => event.kind === 'debate-reveal');
      assert.equal(reveal.views.length, 2);
      assert.deepEqual(reveal.missing, []);
    }
  }
});
