import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, startServer, succeeds, moduleURL } from './helpers.mjs';

for (const enabled of [true, false]) {
  test(`board: a claim ${enabled ? 'blocks another agent' : 'allows edits when claims are disabled'} through PreToolUse`, async (t) => {
    const s = sandbox(t, { policy: { collaboration: { claims: enabled } } });
    const file = s.write(path.join(s.project, 'shared.mjs'), 'export const value = 1;\n');
    const server = startServer(s);
    try {
      const claimed = await server.request('tools/call', { name: 'claim', arguments: { files: ['shared.mjs'], note: 'working here' } });
      assert.match(claimed.result.content[0].text, /Claimed shared.mjs/);
    } finally {
      await server.close();
    }
    for (const field of ['file_path', 'notebook_path']) {
      const hook = s.run('hook.mjs', [], {
        env: { BOARD_AGENT: 'beta' },
        input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: s.project, tool_name: 'Edit', tool_input: { [field]: file } }),
      });
      const output = succeeds(hook);
      if (enabled) {
        const decision = JSON.parse(output).hookSpecificOutput;
        assert.equal(decision.permissionDecision, 'deny');
        assert.match(decision.permissionDecisionReason, /Alpha Claude.*working here/);
      } else assert.equal(output, '');
    }
    const ownEdit = s.run('hook.mjs', [], { input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: s.project, tool_input: { file_path: 'shared.mjs' } }) });
    assert.equal(succeeds(ownEdit), '');
  });
}

test('board: claims expire and only the owner or a forced release can release them', (t) => {
  const s = sandbox(t);
  succeeds(s.evaluate(`
    const { append, claimOn, readAll, realPath } = await import(${JSON.stringify(moduleURL('board.mjs'))});
    const project = process.cwd();
    const file = path.join(project, 'shared.mjs');
    const add = (event) => append({ project, ...event });
    add({ kind: 'claim', from: 'Alpha Claude', files: ['shared.mjs'] });
    assert.equal(claimOn(readAll(), file).by, 'Alpha Claude');
    add({ kind: 'release', from: 'Beta Claude', files: ['shared.mjs'] });
    assert.equal(claimOn(readAll(), file).by, 'Alpha Claude');
    add({ kind: 'release', from: 'Beta Claude', files: ['shared.mjs'], force: true });
    assert.equal(claimOn(readAll(), file), null);
    add({ kind: 'claim', from: 'Alpha Claude', files: ['shared.mjs'], at: Date.now() - 3 * 3600e3 });
    assert.equal(claimOn(readAll(), file), null);
  `));
});
