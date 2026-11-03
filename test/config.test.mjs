import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { agentsConfig, moduleURL, sandbox, succeeds } from './helpers.mjs';

test('config: validates good agents and reports ids, duplicate names, missing directories and two Codex agents', (t) => {
  const s = sandbox(t);
  succeeds(s.evaluate(String.raw`
    const { validateAgents } = await import(${JSON.stringify(moduleURL('lib/config.mjs'))});
    const good = ${JSON.stringify(agentsConfig())};
    assert.deepEqual(validateAgents(good), []);
    const badId = structuredClone(good);
    badId.agents[0].id = '../Alpha';
    assert.match(validateAgents(badId).join('; '), /agents\[0\]\.id must be lowercase/);
    const duplicate = structuredClone(good);
    duplicate.agents[1].name = duplicate.agents[0].name;
    assert.match(validateAgents(duplicate).join('; '), /name .* is used twice/);
    const noDir = structuredClone(good);
    delete noDir.agents[0].configDir;
    assert.match(validateAgents(noDir).join('; '), /configDir is required/);
    const twoCodex = structuredClone(good);
    twoCodex.agents.push({ id: 'second-codex', name: 'Second Codex', kind: 'codex' });
    assert.match(validateAgents(twoCodex).join('; '), /at most one codex agent/);
  `));
});

for (const [label, identity, expected] of [
  ['id', { BOARD_AGENT: 'beta' }, 'Beta Claude'],
  ['name', { BOARD_AGENT: 'Beta Claude' }, 'Beta Claude'],
  ['unknown explicit identity', { BOARD_AGENT: 'Visitor' }, 'Visitor'],
  ['config directory', { BOARD_AGENT: '', CLAUDE_CONFIG_DIR: '~/.claude-beta' }, 'Beta Claude'],
  ['default account', { BOARD_AGENT: '' }, 'Alpha Claude'],
  ['unknown directory', { BOARD_AGENT: '', CLAUDE_CONFIG_DIR: '~/unknown-account' }, 'Unknown agent'],
]) {
  test(`config: whoAmI resolves ${label}`, (t) => {
    const s = sandbox(t);
    succeeds(s.evaluate(`
      const { whoAmI } = await import(${JSON.stringify(moduleURL('lib/config.mjs'))});
      assert.equal(whoAmI(), ${JSON.stringify(expected)});
    `, { env: identity }));
  });
}

test('config: whoAmI resolves symlinked account directories and BOARD_AGENT wins', (t) => {
  const s = sandbox(t);
  const real = path.join(s.home, '.claude-beta');
  const link = path.join(s.home, 'linked-account');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, 'dir');
  succeeds(s.evaluate(`
    const { whoAmI } = await import(${JSON.stringify(moduleURL('lib/config.mjs'))});
    assert.equal(whoAmI(), 'Beta Claude');
    assert.equal(whoAmI({ ...process.env, BOARD_AGENT: 'alpha' }), 'Alpha Claude');
  `, { env: { BOARD_AGENT: '', CLAUDE_CONFIG_DIR: link } }));
});

test('config: agentByName accepts names, ids and aliases; missing setup is harmless', (t) => {
  const s = sandbox(t);
  succeeds(s.evaluate(`
    const { agentByName } = await import(${JSON.stringify(moduleURL('lib/config.mjs'))});
    for (const name of ['Beta Claude', 'beta', 'Ace']) assert.equal(agentByName(name).id, 'beta');
    assert.equal(agentByName('missing'), null);
  `));
  fs.rmSync(path.join(s.board, 'agents.json'));
  succeeds(s.evaluate(`
    const { loadAgents, whoAmI, agentByName } = await import(${JSON.stringify(moduleURL('lib/config.mjs'))});
    assert.equal(loadAgents(), null);
    assert.equal(whoAmI({}), 'Unknown agent');
    assert.equal(agentByName('Ace'), null);
  `));
});
