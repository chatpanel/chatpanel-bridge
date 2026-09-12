import assert from 'node:assert/strict';
import test from 'node:test';

import { callLocalMcp } from '../src/mcp-local.js';

test('local MCP process exit includes recent stderr in the error', async () => {
  const script = [
    'process.stdin.resume();',
    'process.stdin.once("data", () => {',
    '  console.error("npm error code E403");',
    '  console.error("npm error 403 registrynpmjsblockpage");',
    '  process.exit(7);',
    '});',
  ].join('');

  await assert.rejects(
    callLocalMcp(
      {
        key: `stderr-test-${Date.now()}-${Math.random()}`,
        command: process.execPath,
        args: ['-e', script],
      },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    ),
    /local MCP ".+" exited with code 7: npm error code E403\nnpm error 403 registrynpmjsblockpage/,
  );
});

// A server that behaves like the Python SDK: any request before `initialize` is refused.
// The bridge kills an idle server and respawns it on the next call, and that call is never
// `initialize` — the extension handshook once and holds a client it believes is live. So
// the bridge must replay the handshake itself, or the first call after a quiet spell fails.
const STRICT_SERVER = [
  'let ready = false;',
  'let buf = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => {',
  '  buf += d;',
  '  let nl;',
  '  while ((nl = buf.indexOf("\\n")) >= 0) {',
  '    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);',
  '    if (!line.trim()) continue;',
  '    const m = JSON.parse(line);',
  '    if (m.method === "initialize") { ready = true; process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: "strict", version: "1" } } }) + "\\n"); continue; }',
  '    if (m.id == null) continue;',
  '    if (!ready) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "Received request before initialization was complete" } }) + "\\n"); continue; }',
  '    if (m.method === "shutdown") { process.exit(0); }',
  '    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "pid:" + process.pid }] } }) + "\\n");',
  '  }',
  '});',
].join('\n');

test('a respawned local MCP server is re-initialized before the next request', async () => {
  const spec = { key: `respawn-${Date.now()}-${Math.random()}`, command: process.execPath, args: ['-e', STRICT_SERVER] };
  const init = await callLocalMcp(spec, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
  assert.equal(init.result.serverInfo.name, 'strict');
  await callLocalMcp(spec, { jsonrpc: '2.0', method: 'notifications/initialized' });
  const first = await callLocalMcp(spec, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x', arguments: {} } });
  assert.match(first.result.content[0].text, /^pid:\d+$/);

  // The process goes away — an idle kill, a crash, an update. Ask it to exit and wait for
  // the pending map to be torn down.
  await callLocalMcp(spec, { jsonrpc: '2.0', id: 3, method: 'shutdown', params: {} }).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  // The next call arrives with no handshake, exactly as the extension sends it. Before the
  // fix this was the -32002 refusal, surfaced to the model as "the tool is broken".
  const second = await callLocalMcp(spec, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'x', arguments: {} } });
  assert.ok(!second.error, `expected the replayed handshake to make the call succeed, got ${JSON.stringify(second.error)}`);
  assert.match(second.result.content[0].text, /^pid:\d+$/);
  assert.notEqual(second.result.content[0].text, first.result.content[0].text, 'a NEW process answered');

  // Concurrent calls on a fresh process share one handshake — and all succeed.
  await callLocalMcp(spec, { jsonrpc: '2.0', id: 5, method: 'shutdown', params: {} }).catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
  const burst = await Promise.all([6, 7, 8].map((id) => callLocalMcp(spec, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'x', arguments: {} } })));
  for (const r of burst) assert.ok(!r.error && /^pid:/.test(r.result.content[0].text), 'every call in the burst succeeded');
  const pids = new Set(burst.map((r) => r.result.content[0].text));
  assert.equal(pids.size, 1, 'the burst was served by ONE process');
  await callLocalMcp(spec, { jsonrpc: '2.0', id: 9, method: 'shutdown', params: {} }).catch(() => {});
});

test('a server that was never initialized through the bridge gets no replay', async () => {
  // The bridge only replays what it was handed. A caller that skips initialize is a
  // caller bug, and forging a handshake for it would hide that.
  const spec = { key: `noinit-${Date.now()}-${Math.random()}`, command: process.execPath, args: ['-e', STRICT_SERVER] };
  const r = await callLocalMcp(spec, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } });
  assert.equal(r.error?.code, -32002);
  // Tidy up: the fake only honours shutdown once initialized.
  await callLocalMcp(spec, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await callLocalMcp(spec, { jsonrpc: '2.0', id: 3, method: 'shutdown', params: {} }).catch(() => {});
});
