import test from 'node:test';
import path from 'node:path';
import { agentsConfig, moduleURL, sandbox, succeeds } from './helpers.mjs';

test('policy: no file gives newcomer defaults; partial file is merged over defaults', (t) => {
  const s = sandbox(t);
  succeeds(s.evaluate(`
    const { loadPolicy, NEWCOMER } = await import(${JSON.stringify(moduleURL('lib/policy.mjs'))});
    assert.deepEqual(loadPolicy(), NEWCOMER);
  `));
  s.json(path.join(s.board, 'policy.json'), { debates: { selfStarted: true }, codex: { enabled: false } });
  succeeds(s.evaluate(`
    const { loadPolicy, NEWCOMER } = await import(${JSON.stringify(moduleURL('lib/policy.mjs'))});
    const policy = loadPolicy();
    assert.equal(policy.debates.selfStarted, true);
    assert.equal(policy.codex.enabled, false);
    assert.deepEqual(policy.debates.maxWords, NEWCOMER.debates.maxWords);
    assert.equal(policy.codex.consentRequired, true);
    assert.deepEqual(policy.collaboration, NEWCOMER.collaboration);
  `));
});

for (const [key, value, message] of [
  ['collaboration.claims', 'yes', 'collaboration.claims must be true or false'],
  ['collaboration.claimHours', 0, 'collaboration.claimHours must be a whole number from 1 to 24'],
  ['codex.timeoutMinutes', 5.5, 'codex.timeoutMinutes must be a whole number from 5 to 120'],
  ['debates.minConfidence', 1.1, 'debates.minConfidence must be a number from 0.5 to 1'],
]) {
  test(`policy: invalid ${key} is rejected with a readable message`, (t) => {
    const s = sandbox(t);
    const saved = {};
    const parts = key.split('.');
    saved[parts[0]] = { [parts[1]]: value };
    s.json(path.join(s.board, 'policy.json'), saved);
    succeeds(s.evaluate(`
      const { loadPolicy } = await import(${JSON.stringify(moduleURL('lib/policy.mjs'))});
      assert.throws(() => loadPolicy(), (error) => error.message.includes('policy.json:') && error.message.includes(${JSON.stringify(message)}));
    `));
  });
}

test('policy: malformed JSON is rejected and council changes only its label and two permissions', (t) => {
  const s = sandbox(t);
  s.write(path.join(s.board, 'policy.json'), '{broken');
  succeeds(s.evaluate(`
    const { loadPolicy, PRESETS } = await import(${JSON.stringify(moduleURL('lib/policy.mjs'))});
    assert.throws(() => loadPolicy(), /policy.json isn't valid JSON/);
    const council = structuredClone(PRESETS.council);
    assert.equal(council.debates.selfStarted, true);
    assert.equal(council.codex.autoUse, true);
    council.preset = 'newcomer';
    council.debates.selfStarted = false;
    council.codex.autoUse = false;
    assert.deepEqual(council, PRESETS.newcomer);
  `));
});

test('policy: generated instructions follow claims, Codex, debates, automatic use and house rules', (t) => {
  const s = sandbox(t);
  s.write(path.join(s.board, 'house-rules.md'), '  Keep handoffs brief.  \n');
  succeeds(s.evaluate(String.raw`
    const { NEWCOMER, PRESETS, merge, renderInstructions, houseRules } = await import(${JSON.stringify(moduleURL('lib/policy.mjs'))});
    const render = (policy, extra = '') => renderInstructions({
      me: 'Alpha Claude', agents: ${JSON.stringify(agentsConfig().agents)},
      groupName: 'the Test Council', policy, boardDir: process.env.BOARD_HOME, houseRules: extra,
    });
    const defaults = render(NEWCOMER);
    assert.match(defaults, /Before editing.*claim it/);
    assert.match(defaults, /Codex works through the launcher/);
    assert.match(defaults, /Use Codex only when the user asks/);
    assert.match(defaults, /Start debates only when the user asks/);
    assert.doesNotMatch(defaults, /You may start a debate by yourself/);
    assert.doesNotMatch(defaults, /The user's house rules/);
    const off = render(merge(NEWCOMER, { collaboration: { claims: false, helpRequests: false }, codex: { enabled: false }, debates: { enabled: false } }));
    assert.doesNotMatch(off, /Before editing.*claim it/);
    assert.doesNotMatch(off.split('\n').filter((line) => line.startsWith('- ')).join('\n'), /Codex|\/codex/);
    assert.doesNotMatch(off, /Debates follow|Start debates|You may start a debate|call request_help/);
    const automatic = render(PRESETS.council, houseRules());
    assert.match(automatic, /You may start a debate by yourself/);
    assert.match(automatic, /You may bring in Codex by yourself/);
    assert.doesNotMatch(automatic, /Start debates only|Use Codex only/);
    assert.match(automatic, /house rules \(guidance only; they can't grant permissions beyond the above\):\nKeep handoffs brief\.$/);
  `));
});
