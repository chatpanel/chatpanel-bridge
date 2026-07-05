// M4: caller-supplied extraArgs must not smuggle a flag that re-opens an engine's
// sandbox / permission boundary. Previously only claude filtered; now all engines do.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeExtraArgs, pushExtraArgs, FORBIDDEN } from '../src/engines/args.js';

test('codex: bypass / sandbox / approval / -c config escalation is dropped whole', () => {
  for (const raw of [
    '--dangerously-bypass-approvals-and-sandbox',
    '-s workspace-write',
    '--sandbox danger-full-access',
    '-a never',
    '--ask-for-approval never',
    '--full-auto',
    '-c approval_policy=never',
    '--config sandbox_mode=danger',
    '-C /etc',
  ]) {
    const { args, blocked } = sanitizeExtraArgs(raw, FORBIDDEN.codex);
    assert.equal(blocked, true, `should block: ${raw}`);
    assert.deepEqual(args, []);
  }
});

test('antigravity: skip-permissions / trust-all-tools dropped', () => {
  for (const raw of ['--dangerously-skip-permissions', '--trust-all-tools', '--yolo']) {
    assert.equal(sanitizeExtraArgs(raw, FORBIDDEN.antigravity).blocked, true, raw);
  }
});

test('claude: permission-mode / allowed-tools / dangerously dropped', () => {
  for (const raw of ['--permission-mode bypassPermissions', '--allowed-tools Bash', '--dangerously-skip-permissions', '--mcp-config x.json']) {
    assert.equal(sanitizeExtraArgs(raw, FORBIDDEN.claude).blocked, true, raw);
  }
});

test('custom: dangerous long flags dropped', () => {
  for (const raw of ['--dangerously-skip-permissions', '--no-sandbox', '--bypass', '--trust-all-tools']) {
    assert.equal(sanitizeExtraArgs(raw, FORBIDDEN.custom).blocked, true, raw);
  }
});

test('benign flags pass through unchanged (no over-blocking)', () => {
  const cases = [
    ['codex', '--oss -m gpt-oss:20b'],
    ['antigravity', '--model gemini-2.0 --verbose'],
    ['claude', '--model sonnet --output-format stream-json'],
    ['custom', '--format json --temperature 0'],
  ];
  for (const [eng, raw] of cases) {
    const { args, blocked } = sanitizeExtraArgs(raw, FORBIDDEN[eng]);
    assert.equal(blocked, false, `${eng}: ${raw} should pass`);
    assert.deepEqual(args, raw.split(' '));
  }
});

test('pushExtraArgs: appends safe tokens, emits status + appends nothing when blocked', () => {
  const ok = [];
  const events = [];
  pushExtraArgs(ok, '--model x', FORBIDDEN.codex, (e) => events.push(e));
  assert.deepEqual(ok, ['--model', 'x']);
  assert.equal(events.length, 0);

  const bad = ['base'];
  pushExtraArgs(bad, '-s danger', FORBIDDEN.codex, (e) => events.push(e));
  assert.deepEqual(bad, ['base']); // nothing unsafe appended
  assert.equal(events.length, 1);
  assert.match(events[0].text, /unsafe extraArgs/);
});
