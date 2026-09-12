// forwardAgyLine translates `agy --output-format stream-json` into the bridge's streaming
// vocabulary. Schema pinned from a live agy 1.2.2 capture: the plain-text mode this engine
// used to read carries no tool activity at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardAgyLine, newAgyState } from '../src/engines/antigravity.js';

function run(lines) {
  const out = [];
  const state = newAgyState();
  const flags = lines.map((l) => forwardAgyLine(typeof l === 'string' ? l : JSON.stringify(l), (o) => out.push(o), state));
  return { out, state, flags };
}

test('a tool step → start with its parameters, done with its output, correlated by step_index', () => {
  const { out, flags } = run([
    { event: 'init', init: { cwd: '/w', tools: ['run_command'] } },
    { event: 'step_update', step_update: { step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'date' } } } },
    { event: 'step_update', step_update: { step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', duration_seconds: 0.05, tool_info: { name: 'run_command', parameters: { CommandLine: 'date' }, output: 'Sat Sep 12 07:27:27 PDT 2026\n' } } },
  ]);
  assert.deepEqual(out[0], { type: 'status', text: 'Antigravity working' });
  assert.deepEqual(out[1], { type: 'tool', name: 'run_command', phase: 'start', callId: 'agy_2', input: { CommandLine: 'date' } });
  assert.deepEqual(out[2], { type: 'tool', name: 'run_command', phase: 'done', callId: 'agy_2', status: 'ok', result: 'Sat Sep 12 07:27:27 PDT 2026\n' });
  assert.ok(flags.every((f) => !f.streamed), 'tool activity is not the answer');
});

test('the answer streams from text_delta; result keeps the whole response for a run that streamed nothing', () => {
  const { out, state, flags } = run([
    { event: 'step_update', step_update: { step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '07:27:27 PDT' } },
    { event: 'step_update', step_update: { step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n', usage: { output_tokens: 162 } } },
    { event: 'result', result: { status: 'SUCCESS', response: '07:27:27 PDT\n', num_turns: 1 } },
  ]);
  assert.deepEqual(out.map((o) => o.text), ['07:27:27 PDT', '\n']);
  assert.equal(flags[0].streamed, true);
  assert.equal(state.finalText, '07:27:27 PDT\n');
  const only = run([{ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'agent_response', usage: {} } }]);
  assert.equal(only.out.length, 0, 'a response step with no text emits nothing');
});

test('a non-JSON line is shown as text; a failed result and a tool error are surfaced', () => {
  const { out } = run([
    'Warning: something the CLI printed',
    { event: 'step_update', step_update: { step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { path: 'x' }, error: 'ENOENT' } } },
    { event: 'result', result: { status: 'ERROR', response: '' } },
    '',
  ]);
  assert.deepEqual(out[0], { type: 'delta', text: 'Warning: something the CLI printed\n' });
  assert.equal(out[1].phase, 'start');
  assert.equal(out[2].status, 'error: ENOENT');
  assert.equal(out[3].text, 'Antigravity: ERROR');
  assert.equal(out.length, 4);
});
