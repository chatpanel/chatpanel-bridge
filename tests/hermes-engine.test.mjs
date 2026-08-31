// Hermes as a first-class bridge agent. Its flags come from the real CLI (v0.20.x):
//   hermes -z "<prompt>"   one-shot; prints ONLY the final text, approvals auto-bypassed
//   -m <model>             model override
//   config get model       the only non-interactive way to read the configured model
//   mcp add/list           where the bridge registers its browser tools
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hermes } from '../src/engines/cli-agents.js';
import { stableMcpSetupPlan } from '../src/engines/custom.js';

test('the spec matches the CLI contract', () => {
  const s = hermes.spec;
  assert.equal(s.command, 'hermes');
  assert.equal(s.args, '-z {prompt}', 'one-shot, with the prompt BOUND to the flag');
  assert.equal(s.promptVia, 'arg');
  assert.equal(s.modelArg, '-m {model}');
  assert.equal(s.label, 'Hermes');
});

test('browser tools register over STDIO — Hermes has no HTTP MCP transport', () => {
  const s = hermes.spec;
  assert.equal(s.requiresStableMcp, true, 'Hermes reads MCP only from its own config');
  assert.equal(s.autoSetupStableMcp, true);
  assert.equal(s.stableMcpConfigCheck, 'hermes');

  // A --url registration saves a config that can never connect: Hermes's bundled MCP client
  // reports "requires HTTP transport but mcp.client.streamable_http is not available". The
  // bridge also speaks MCP over stdio (the mode Codex uses), so we register that.
  const plan = stableMcpSetupPlan(s);
  assert.equal(plan.command, 'hermes');
  assert.ok(plan.args.includes('--command'), 'registers a stdio command');
  assert.ok(plan.args.includes('--mcp-stdio'), 'pointing at the bridge stdio MCP mode');
  assert.ok(!plan.args.includes('--url'), 'never the HTTP transport Hermes cannot use');
  assert.equal(plan.args[plan.args.length - 4], '--args', '`--args` is last, as hermes mcp add requires');
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


test('the prompt is the VALUE of -z, not a trailing positional', () => {
  // Hermes uses Python argparse: `-z` requires its value immediately. The runner appends a
  // trailing prompt only when there is no {prompt} placeholder — and it inserts the model
  // flag first, which produced `hermes -z -m <model> "<prompt>"` and the real error
  // "argument -z/--oneshot: expected one argument". The placeholder is what prevents it.
  const spec = hermes.spec;
  assert.match(spec.args, /\{prompt\}/, 'the placeholder binds the prompt to -z');

  // Reproduce the runner's assembly order: base args → model flag → prompt substitution.
  let args = String(spec.args).split(/\s+/).filter(Boolean);
  args = [...args, ...spec.modelArg.replace('{model}', 'some/model').split(' ')];
  const prompt = 'a prompt with spaces';
  let placed = false;
  args = args.map((a) => (a.includes('{prompt}') ? ((placed = true), a.replaceAll('{prompt}', prompt)) : a));
  if (!placed) args.push(prompt);

  assert.deepEqual(args, ['-z', prompt, '-m', 'some/model']);
  assert.notEqual(args[1], '-m', 'the flag after -z must never be another flag');
});

test('a missing MCP SDK degrades the turn instead of killing it', async () => {
  const { mcpSetupHint } = await import('../src/engines/custom.js');
  // Hermes ships without the `mcp` Python SDK unless `hermes setup` installed it. The turn
  // must still answer — browser tools are an enhancement on top of the CLI's own 21 toolsets,
  // not a precondition — and the message must name the fix that actually works.
  const hint = mcpSetupHint('Hermes', new Error("requires the 'mcp' Python SDK, but it is not installed"));
  assert.match(hint, /hermes setup/, 'points at the command that installs MCP support');
  assert.ok(!/mcp add/.test(hint), 'does not repeat an `mcp add` that fails identically');

  // The HTTP-transport case names the transport, not a reinstall.
  const http = mcpSetupHint('Hermes', new Error('mcp.client.streamable_http is not available'));
  assert.match(http, /stdio/, 'explains that a stdio server is registered instead');

  // Anything else forwards the CLI's own words — the most accurate signal available.
  assert.match(mcpSetupHint('X', new Error('some other failure')), /some other failure/);
});

test("the CLI's own reason survives into the message the user sees", async () => {
  const { ensureStableMcpConfig, mcpSetupHint } = await import('../src/engines/custom.js');
  // `hermes mcp add` exits 0 while registering nothing and explaining why on stdout. If that
  // output is dropped, the user gets "still not visible — run `mcp add`", which is the
  // command that just failed. Carrying it through is what makes the hint able to match.
  let caught;
  try {
    await ensureStableMcpConfig(hermes.spec, '/tmp', 'Hermes', () => {}, {
      hasConfig: async () => false,
      runSetup: async () => "✗ Failed to connect: requires the 'mcp' Python SDK, but it is not installed.",
    });
  } catch (e) { caught = e; }
  assert.ok(caught, 'setup that registers nothing still raises');
  assert.match(caught.message, /Python SDK/, "the CLI's explanation is preserved");
  assert.match(mcpSetupHint('Hermes', caught), /hermes setup/, 'so the hint names the real fix');
});
