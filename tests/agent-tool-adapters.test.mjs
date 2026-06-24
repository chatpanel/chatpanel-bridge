import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { claudeMcpConfig } from '../src/engines/claude.js';
import { codexMcpConfigArgs } from '../src/engines/codex.js';
import {
  buildPiExtensionSource,
  commandOutput,
  ensureStableMcpConfig,
  piToolArgs,
  stableMcpSetupPlan,
  stableMcpSetupCommand,
  trustToolArgs,
} from '../src/engines/custom.js';
import { kiro } from '../src/engines/cli-agents.js';

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

test('Kiro uses stable MCP setup and trusts the current ChatPanel tools', () => {
  assert.equal(kiro.spec.requiresStableMcp, true);
  assert.equal(kiro.spec.autoSetupStableMcp, true);
  assert.equal(kiro.spec.stableMcpConfigCheck, 'kiro');
  assert.equal(
    stableMcpSetupCommand(kiro.spec),
    'kiro-cli mcp add --scope global --name chatpanel_browser --url http://127.0.0.1:4319/mcp --force',
  );
  assert.deepEqual(stableMcpSetupPlan(kiro.spec), {
    command: 'kiro-cli',
    args: ['mcp', 'add', '--scope', 'global', '--name', 'chatpanel_browser', '--url', 'http://127.0.0.1:4319/mcp', '--force'],
  });
  assert.deepEqual(trustToolArgs(kiro.spec.trustToolsArg, mcp), [
    '--trust-tools=browser_click,browser_snapshot',
  ]);
});

test('Kiro auto-runs its one-time stable MCP setup when missing', async () => {
  const statuses = [];
  let setupRan = false;
  let checks = 0;

  await ensureStableMcpConfig(kiro.spec, null, 'Kiro', (event) => statuses.push(event.text), {
    hasConfig: async () => ++checks > 1,
    runSetup: async (plan) => {
      setupRan = true;
      assert.equal(plan.command, 'kiro-cli');
      assert.deepEqual(plan.args.slice(0, 3), ['mcp', 'add', '--scope']);
    },
  });

  assert.equal(setupRan, true);
  assert.equal(checks, 2);
  assert.match(statuses.join('\n'), /setting up one-time browser tools/);
});

test('Stable MCP agents without auto setup fail fast instead of running tool-less', async () => {
  const spec = {
    command: 'example-agent',
    requiresStableMcp: true,
    stableMcpSetupCommand: 'example-agent mcp add chatpanel',
  };
  const statuses = [];

  await assert.rejects(
    () => ensureStableMcpConfig(spec, null, 'Example', (event) => statuses.push(event.text), {
      hasConfig: async () => false,
      runSetup: async () => assert.fail('setup should not run for non-auto agents'),
    }),
    /Example needs one-time browser-tool setup: example-agent mcp add chatpanel/,
  );
  assert.match(statuses.join('\n'), /needs one-time browser-tool setup/);
});

test('Stable MCP config checks include stderr output from CLIs like Kiro', async () => {
  const output = await commandOutput(process.execPath, ['-e', 'process.stderr.write("chatpanel_browser")'], null);
  assert.equal(output, 'chatpanel_browser');
});

test('Custom stable-MCP agents are not treated as OpenCode by default', () => {
  const customJs = readFileSync(new URL('../src/engines/custom.js', import.meta.url), 'utf8');
  assert.doesNotMatch(customJs, /\|\| !spec\.stableMcpConfigCheck/, 'Custom agents without a known check should not reuse the OpenCode config check.');
});
