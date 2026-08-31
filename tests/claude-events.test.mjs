// The Claude engine must stream what it's DOING, not just that it did something: each tool
// call as a step with its arguments, then its outcome and output. Mirrors codex-events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from '../src/engines/claude.js';

function run(msgs) {
  const out = [];
  let streamed = false;
  for (const m of msgs) {
    const r = handleMessage(m, (e) => out.push(e), streamed);
    if (r.streamed) streamed = true;
  }
  return out;
}

test('a tool call streams as start (with args) then done (with status + output)', () => {
  const out = run([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/a.txt' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents here' }] } },
  ]);
  const start = out.find((e) => e.phase === 'start');
  const done = out.find((e) => e.phase === 'done');
  assert.equal(start.name, 'Read');
  assert.equal(start.callId, 'tu_1');
  assert.deepEqual(start.input, { file_path: '/tmp/a.txt' }, 'the arguments reach the step');
  assert.ok(start.summary, 'the legacy summary is still sent for older clients');
  assert.equal(done.callId, 'tu_1', 'the outcome is paired to its call');
  assert.equal(done.status, 'ok');
  assert.equal(done.result, 'file contents here');
});

test('a failing tool is marked as an error, not silently ok', () => {
  const out = run([
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_9', is_error: true, content: 'ENOENT' }] } },
  ]);
  assert.equal(out[0].status, 'error');
  assert.equal(out[0].result, 'ENOENT');
});

test('block-array tool results are flattened, and huge ones capped', () => {
  const out = run([
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'big', content: 'x'.repeat(10_000) }] } },
  ]);
  assert.equal(out[0].result, 'one\ntwo');
  assert.ok(out[1].result.length <= 4001, 'a megabyte file read is not pushed through the SSE');
  assert.ok(out[1].result.endsWith('…'), 'and the truncation is visible');
});

test('thinking still streams as reasoning text', () => {
  const out = run([
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'weighing options' } } },
  ]);
  assert.deepEqual(out[0], { type: 'reasoning', text: 'weighing options' });
});

test('assistant text streams once, not twice', () => {
  const out = run([
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } },
  ]);
  assert.equal(out.filter((e) => e.type === 'delta').length, 1, 'the assistant echo is not re-emitted');
});
