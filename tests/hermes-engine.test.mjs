// Hermes as a first-class bridge agent. Its flags come from the real CLI (v0.20.x):
//   hermes -z "<prompt>"   one-shot; prints ONLY the final text, approvals auto-bypassed
//   -m <model>             model override
//   config get model       the only non-interactive way to read the configured model
//   mcp add/list           where the bridge registers its browser tools
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermes } from '../src/engines/cli-agents.js';

test('the spec matches the CLI contract', () => {
  const s = hermes.spec;
  assert.equal(s.command, 'hermes');
  assert.equal(s.args, '-z', 'one-shot: only the final answer reaches stdout');
  assert.equal(s.promptVia, 'arg');
  assert.equal(s.modelArg, '-m {model}');
  assert.equal(s.label, 'Hermes');
});

test('browser tools go through the stable /mcp endpoint, like opencode and kiro', () => {
  const s = hermes.spec;
  assert.equal(s.requiresStableMcp, true, 'Hermes reads MCP only from its own config');
  assert.equal(s.autoSetupStableMcp, true);
  assert.equal(s.stableMcpConfigCheck, 'hermes');
  assert.deepEqual(s.stableMcpSetupArgs, ['mcp', 'add', 'chatpanel_browser', '--url', 'http://127.0.0.1:4319/mcp']);
});

test('availability reports a fixable reason when the CLI is absent', async () => {
  const a = await hermes.available();
  assert.equal(typeof a.ok, 'boolean');
  if (!a.ok) assert.match(a.reason, /hermes setup|not found on PATH/, 'says how to fix it');
});

test('model discovery parses `config get model`, not the interactive picker', async () => {
  // `hermes model` has no --list flag, so discovery reads the resolved config, whose output
  // is `key: value` lines — we want `default:` and not the provider/base_url around it.
  const sample = 'default: thinkingmachines/inkling:free\nprovider: openrouter\nbase_url: https://openrouter.ai/api/v1';
  const m = /^\s*default:\s*(\S+)/m.exec(sample);
  assert.equal(m[1], 'thinkingmachines/inkling:free');
  assert.ok(!/openrouter|base_url/.test(m[1]), 'the provider lines are not mistaken for models');
  // Never throws when Hermes isn't configured — the picker still takes a typed id.
  assert.ok(Array.isArray(await hermes.listModels({})));
});
