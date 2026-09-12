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

test('web_search → a web_search step; the query arrives only at completion (codex-cli 0.154 capture)', () => {
  // The turn that showed the gap: a weekend-weather question searched the web four times,
  // the CLI printed "Searching the web" each time, and the panel showed nothing at all.
  const id = 'exec-598da690-85c3-4ca2-b672-afa501c3dbc9';
  const out = run([
    { type: 'item.started', item: { id, type: 'web_search', query: '', action: { type: 'other' } } },
    { type: 'item.completed', item: { id, type: 'web_search', query: 'Issaquah WA weather forecast September 12 13 2026 weekend', action: { type: 'search', query: 'Issaquah WA weather forecast September 12 13 2026 weekend' } } },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { type: 'tool', name: 'web_search', phase: 'start', callId: id, input: { query: '' } });
  assert.equal(out[1].phase, 'done');
  assert.equal(out[1].status, 'ok');
  assert.match(out[1].result, /Searched the web for Issaquah WA weather/);
  // An open_page action names the url.
  const opened = run([{ type: 'item.completed', item: { id: 'w2', type: 'web_search', query: '', action: { type: 'open_page', url: 'https://forecast.weather.gov/x' } } }]);
  assert.deepEqual(opened[0].input, { query: '', url: 'https://forecast.weather.gov/x' });
  assert.equal(opened[1].result, 'Opened https://forecast.weather.gov/x');
});

test('mcp_tool_call → a step named server/tool with its arguments, result or error', () => {
  const out = run([
    { type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'chatpanel', tool: 'search_history', arguments: { query: 'demo' }, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'chatpanel', tool: 'search_history', arguments: { query: 'demo' }, result: { content: [{ type: 'text', text: '3 results' }] }, status: 'completed' } },
  ]);
  assert.deepEqual(out[0], { type: 'tool', name: 'chatpanel/search_history', phase: 'start', callId: 'm1', input: { query: 'demo' } });
  assert.equal(out[1].status, 'ok');
  assert.match(out[1].result, /3 results/);
  const failed = run([{ type: 'item.completed', item: { id: 'm2', type: 'mcp_tool_call', server: 'jira', tool: 'get_issue', arguments: {}, error: { message: 'not found' }, status: 'failed' } }]);
  assert.equal(failed[1].status, 'error: not found');
});

test('todo_list → the plan as one status, only when it changes; error → a status line', () => {
  const state = { started: new Set(), reasoned: new Set(), n: 0 };
  const out = [];
  const emit = (o) => out.push(o);
  const items = [{ text: 'search', completed: true }, { text: 'answer', completed: false }];
  forwardEvent({ type: 'item.updated', item: { id: 't', type: 'todo_list', items } }, emit, state);
  forwardEvent({ type: 'item.updated', item: { id: 't', type: 'todo_list', items } }, emit, state);
  assert.equal(out.length, 1);
  assert.match(out[0].text, /☑ search\n☐ answer/);
  forwardEvent({ type: 'item.completed', item: { id: 'e', type: 'error', message: 'rate limited' } }, emit, state);
  assert.equal(out[1].text, 'Codex: rate limited');
});

test('the managed-requirements warning is said once, in a sentence, and remembered', () => {
  const state = { started: new Set(), reasoned: new Set(), n: 0 };
  const out = [];
  const emit = (o) => out.push(o);
  const msg = 'Configured value for `approval_policy` is disallowed by requirements; falling back to required value OnRequest. Details: invalid value for `approval_policy`: `Never` is not in the allowed set [OnRequest, UnlessTrusted] (set by enterprise-managed requirements)';
  forwardEvent({ type: 'error', message: msg }, emit, state);
  forwardEvent({ type: 'item.completed', item: { id: 'e', type: 'error', message: msg } }, emit, state);
  assert.equal(out.length, 1, 'said once');
  assert.match(out[0].text, /your organisation pins approval_policy/);
  assert.doesNotMatch(out[0].text, /enterprise-managed|Details:/, 'the paragraph is gone');
  assert.equal(state.policyBlocked, true, 'remembered, so the next run stops passing the flag');
});
