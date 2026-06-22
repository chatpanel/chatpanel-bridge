import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeMcpConfig } from '../src/engines/claude.js';
import { codexMcpConfigArgs } from '../src/engines/codex.js';
import { buildPiExtensionSource, piToolArgs } from '../src/engines/custom.js';

const mcp = {
  url: 'http://127.0.0.1:4319/mcp/session-1',
  serverName: 'chatpanel_browser',
  specs: [
    {
      name: 'browser_click',
      description: 'Click an element',
      parameters: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
    {
      name: 'browser_snapshot',
      description: 'Capture the page',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  ],
};

test('Codex browser MCP config pre-approves relayed page tools', () => {
  const args = codexMcpConfigArgs(mcp);

  assert(args.includes('-c'));
  assert(args.includes('mcp_servers.chatpanel_browser.default_tools_approval_mode="approve"'));
  assert(args.includes('mcp_servers.chatpanel_browser.startup_timeout_sec=30'));
  assert(args.includes('mcp_servers.chatpanel_browser.tool_timeout_sec=120'));
  assert(args.includes('mcp_servers.chatpanel_browser.enabled_tools=["browser_click","browser_snapshot"]'));
});

test('Claude browser MCP config uses the bridge stdio proxy and pre-allows page tools', () => {
  const cfg = claudeMcpConfig(mcp);
  const server = cfg.config.mcpServers.chatpanel_browser;

  assert.equal(server.type, undefined);
  assert.equal(server.url, undefined);
  assert.equal(typeof server.command, 'string');
  assert(server.args.includes('--mcp-stdio'));
  assert(server.args.includes(mcp.url));
  assert.deepEqual(cfg.allowedTools, [
    'mcp__chatpanel_browser__browser_click',
    'mcp__chatpanel_browser__browser_snapshot',
  ]);
});

test('Pi browser tool extension registers page tools and relays calls over MCP', () => {
  const source = buildPiExtensionSource(mcp);

  assert.match(source, /registerTool\(browser_clickTool\)/);
  assert.match(source, /registerTool\(browser_snapshotTool\)/);
  assert.match(source, /method: "tools\/call"/);
  assert.match(source, /params: \{ name: toolName, arguments: params \|\| \{\} \}/);
  assert.match(source, /type: "image"/);
});

test('Pi tool args load the generated extension without disabling built-in tools', () => {
  assert.deepEqual(piToolArgs('/tmp/chatpanel-pi-tools.ts', mcp), ['--extension', '/tmp/chatpanel-pi-tools.ts']);
});
