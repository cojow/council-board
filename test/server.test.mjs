import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, startServer } from './helpers.mjs';

test('server: MCP initialize, tools/list, post and check_in round-trip through BOARD_HOME', async (t) => {
  const s = sandbox(t);
  const server = startServer(s);
  try {
    const init = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'isolated-test', version: '1' } });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'board');
    assert.match(init.result.instructions, /You are Alpha Claude/);
    const listed = await server.request('tools/list');
    for (const name of ['post', 'check_in', 'claim', 'release', 'debate_submit']) {
      assert.ok(listed.result.tools.some((tool) => tool.name === name), name);
    }
    const posted = await server.request('tools/call', { name: 'post', arguments: { text: 'A deterministic test message.' } });
    assert.equal(posted.result.content[0].text, 'Posted.');
    const check = await server.request('tools/call', { name: 'check_in', arguments: {} });
    assert.match(check.result.content[0].text, /A deterministic test message\./);
    assert.match(check.result.content[0].text, /Alpha Claude/);
    const log = path.join(s.board, 'events.jsonl');
    const events = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'message');
    assert.equal(events[0].from, 'Alpha Claude');
    assert.equal(events[0].project, s.project);
    assert.equal(fs.existsSync(path.join(s.home, '.claude')), false);
    assert.equal(fs.existsSync(path.join(s.home, 'Library')), false);
    const unknown = await server.request('unknown-method');
    assert.equal(unknown.error.code, -32601);
  } finally {
    await server.close();
  }
});
