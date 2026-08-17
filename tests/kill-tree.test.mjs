import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { killOnAbort, spawnGroupOpts } from '../src/proc.js';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('Stop kills the CLI and everything it spawned', { skip: process.platform === 'win32' }, async () => {
  // An agent CLI is not one process: codex runs shell commands, claude runs tools. Killing
  // only the pid we hold left those running — a user pressed Stop, watched the panel go
  // quiet, and found the process still going.
  //
  // A shell that spawns a long sleeper and waits, mirroring that shape exactly.
  const child = spawn('/bin/sh', ['-c', 'sleep 30 & echo $! ; wait'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    ...spawnGroupOpts,
  });
  const grandchildPid = await new Promise((resolve) => {
    child.stdout.once('data', (b) => resolve(Number(String(b).trim())));
  });
  assert.ok(grandchildPid > 0, 'the test never started a grandchild');
  assert.equal(alive(grandchildPid), true);

  const ac = new AbortController();
  killOnAbort(child, ac.signal, { graceMs: 200 });
  ac.abort();

  // SIGTERM to the group, then SIGKILL after the grace — allow for both.
  for (let i = 0; i < 40 && (alive(child.pid) || alive(grandchildPid)); i++) await sleep(50);

  assert.equal(alive(grandchildPid), false, 'the grandchild survived Stop — this is the orphan bug');
  assert.equal(alive(child.pid), false, 'the CLI itself survived Stop');
});

test('a child spawned WITHOUT the group option is still killed', { skip: process.platform === 'win32' }, async () => {
  // The fallback matters: an engine that has not adopted spawnGroupOpts yet must still stop,
  // even though its grandchildren will not. Killing one is better than killing none.
  const child = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' });
  const ac = new AbortController();
  killOnAbort(child, ac.signal, { graceMs: 200 });
  ac.abort();
  for (let i = 0; i < 40 && alive(child.pid); i++) await sleep(50);
  assert.equal(alive(child.pid), false);
});

test('spawnGroupOpts is a no-op on Windows, which has no process groups here', () => {
  // Asserted so the platform guard is a decision rather than an accident: on Windows the
  // negative-pid kill is meaningless and the single-process kill is what runs.
  const expected = process.platform === 'win32' ? {} : { detached: true };
  assert.deepEqual(spawnGroupOpts, expected);
});
