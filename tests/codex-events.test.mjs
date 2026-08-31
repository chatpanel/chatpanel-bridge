// forwardEvent translates Codex `exec --json` events into the bridge's streaming vocabulary
// the panel renders richly: a shell step with its command + output + status, reasoning text,
// file edits. Schema pinned from a live codex-cli 0.15x capture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forwardEvent } from '../src/engines/codex.js';

function run(events) {
  const out = [];
  const state = { started: new Set(), reasoned: new Set(), n: 0 };
  for (const ev of events) forwardEvent(ev, (o) => out.push(o), state);
  return out;
}

test('command_execution → tool start (command) then done (output + status), correlated by id', () => {
  const out = run([
    { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: '/bin/zsh -lc ls', aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'command_execution', command: '/bin/zsh -lc ls', aggregated_output: 'a.txt\nb.txt\n', exit_code: 0, status: 'completed' } },
  ]);
  assert.deepEqual(out[0], { type: 'tool', name: 'shell', phase: 'start', callId: 'item_2', input: { command: '/bin/zsh -lc ls' } });
  assert.deepEqual(out[1], { type: 'tool', name: 'shell', phase: 'done', callId: 'item_2', status: 'ok', result: 'a.txt\nb.txt\n' });
  assert.equal(out.length, 2, 'no duplicate start from the two events');
});

test('a non-zero exit is surfaced as a failing status', () => {
  const out = run([
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'false', aggregated_output: '', exit_code: 1, status: 'failed' } },
  ]);
  // Only a completed event: emits both the start (so the step exists) and the failing done.
  assert.equal(out[0].phase, 'start');
  assert.equal(out[1].phase, 'done');
  assert.equal(out[1].status, 'exit 1');
});

test('reasoning summary is forwarded as text, once per item', () => {
  const out = run([
    { type: 'item.started', item: { id: 'r1', type: 'reasoning', text: 'Thinking about the plan.' } },
    { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Thinking about the plan.' } },
  ]);
  assert.equal(out.length, 1, 'the repeated item id is emitted only once');
  assert.equal(out[0].type, 'reasoning');
  assert.match(out[0].text, /Thinking about the plan\./);
});

test('file_change → an edit step naming the files', () => {
  const out = run([
    { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'src/a.js' }, { path: 'src/b.js' }] } },
  ]);
  assert.equal(out[0].name, 'edit');
  assert.deepEqual(out[0].input.files, ['src/a.js', 'src/b.js']);
  assert.equal(out[1].phase, 'done');
});

test('turn/thread start → a working status; no crash on empty events', () => {
  assert.deepEqual(run([{ type: 'turn.started' }]), [{ type: 'status', text: 'Codex working' }]);
  assert.deepEqual(run([{}]), []);
});
