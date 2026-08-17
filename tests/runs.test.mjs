// Stop used to depend on Node noticing the client's socket close. That is a signal about a
// socket, not about intent: it arrives late, and on a request whose body was already
// consumed it may not arrive at all — so a codex `shell:` step ran on for minutes after the
// button was pressed, with nothing left listening to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { startRun, endRun, cancelRun, cancelAll, activeRuns } from '../src/runs.js';

test('a run can be cancelled by name, and its signal fires', () => {
  const run = startRun('run_a');
  let aborted = false;
  run.signal.addEventListener('abort', () => { aborted = true; });
  assert.equal(cancelRun('run_a'), true);
  assert.equal(aborted, true, 'the engines kill their child off this signal');
  endRun('run_a');
});

test('cancelling twice is not an error, and neither is cancelling nothing', () => {
  // "Already finished" and "cancelled" are the same outcome to the caller; a race must not
  // look like a failure.
  const run = startRun('run_b');
  assert.equal(run.cancel(), true);
  assert.equal(run.cancel(), false);
  assert.equal(cancelRun('never-existed'), false);
  endRun('run_b');
});

test('a cancelled run remembers why', () => {
  const run = startRun('run_c');
  run.cancel('stopped');
  assert.equal(run.cancelled, 'stopped');
  endRun('run_c');
});

test('children spawned by sub-agents are tracked, and forgotten when they exit', () => {
  // An agent that spawns sub-agents spawns processes the registry never sees at spawn time.
  const run = startRun('run_d');
  const child = Object.assign(new EventEmitter(), { pid: 1234 });
  run.track(child);
  assert.equal(run.children.size, 1);
  child.emit('exit', 0);
  assert.equal(run.children.size, 0, 'a finished child is not something Stop needs to kill');
  // A child with no pid never started; tracking it would make the set lie.
  run.track({});
  assert.equal(run.children.size, 0);
  endRun('run_d');
});

test('shutdown cancels every run — an orphan nobody can find is the worst outcome', () => {
  startRun('run_e');
  startRun('run_f');
  const before = activeRuns();
  assert.ok(before >= 2);
  assert.ok(cancelAll('shutdown') >= 2);
  // Already-cancelled runs are not counted twice.
  assert.equal(cancelAll('shutdown'), 0);
  endRun('run_e');
  endRun('run_f');
});

test('ending a run removes it, so the registry cannot grow without bound', () => {
  const n = activeRuns();
  startRun('run_g');
  assert.equal(activeRuns(), n + 1);
  endRun('run_g');
  assert.equal(activeRuns(), n);
});

// A process-group kill is not enough on its own. codex runs each shell step in its OWN
// process group, so signalling the group we created deliberately misses it — a `sleep 90`
// survived Stop with PGID equal to its own pid, then reparented to init where nothing
// connected it to the run that started it.
test('the process tree is snapshotted before anything is signalled', async () => {
  const src = await import('node:fs').then((m) => m.readFileSync(new URL('../src/proc.js', import.meta.url), 'utf8'));
  // Reading the tree AFTER killing the parent finds nothing: the links are already gone.
  const onAbort = src.slice(src.indexOf('const onAbort'), src.indexOf('if (signal.aborted)'));
  assert.ok(/const tree = descendantsOf\(child\.pid\)/.test(onAbort), 'the tree is read up front');
  assert.ok(onAbort.indexOf('descendantsOf') < onAbort.indexOf("killTree(child, 'SIGTERM'"), 'before the first signal');
  // And the same snapshot is used for the escalation, which runs when the parent is gone.
  assert.ok(/setTimeout\(\(\) => killTree\(child, 'SIGKILL', tree\)/.test(onAbort));
});

test('descendants are signalled before the parent', async () => {
  const src = await import('node:fs').then((m) => m.readFileSync(new URL('../src/proc.js', import.meta.url), 'utf8'));
  const fn = src.slice(src.indexOf('function killTree'), src.indexOf('export function killOnAbort'));
  assert.ok(fn.indexOf('process.kill(pid, sig)') < fn.indexOf('process.kill(-child.pid'), 'children first, while the parent can still be traced through');
});
