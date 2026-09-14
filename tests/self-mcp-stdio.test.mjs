// THE PER-TURN TOOLS' SERVER COMMAND, WHEN THE BRIDGE LIVES INSIDE THE GATEWAY.
//
// Every CLI agent (Claude Code, Codex, a custom CLI) reaches ChatPanel's per-turn tools —
// `team`, the page and note tools — through a stdio MCP server whose command is "re-run this
// bridge with --mcp-stdio <url>". Embedded in the gateway (one install, 0.6.92+) "this
// bridge" is `chatpanel-gateway`, whose CLI only forwards argv to the bridge behind
// `--bridge`. Without it: "unknown option: --mcp-stdio", exit 2, and Claude Code reported
// the ChatPanel MCP server as "Connection closed" — a saved team ran as one agent doing a
// web search, and the board stayed empty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfMcpStdio } from '../src/env.js';

const URL = 'http://127.0.0.1:4319/mcp/s1';

test('standalone under node: node <entry> --mcp-stdio <url>', () => {
  delete process.env.CHATPANEL_BRIDGE_EMBEDDED;
  const { command, args } = selfMcpStdio(URL);
  assert.equal(command, process.execPath);
  assert.deepEqual(args.slice(-2), ['--mcp-stdio', URL]);
  assert.ok(!args.includes('--bridge'));
});

test('embedded in the gateway: the flag rides behind --bridge', () => {
  process.env.CHATPANEL_BRIDGE_EMBEDDED = '1';
  try {
    const { command, args } = selfMcpStdio(URL);
    assert.equal(command, process.execPath);
    assert.deepEqual(args.slice(-3), ['--bridge', '--mcp-stdio', URL]);
    assert.equal(args[0], process.argv[1]);
  } finally {
    delete process.env.CHATPANEL_BRIDGE_EMBEDDED;
  }
});
