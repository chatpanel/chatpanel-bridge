import { execFileSync } from 'node:child_process';
// Terminate a spawned CLI child when an AbortSignal fires. The extension's Stop
// button aborts the /chat request; server.js turns that disconnect into an abort on
// this signal. Without this, the agent CLI (codex / claude / agy / custom) keeps
// running to completion in the background after Stop — burning tokens and holding the
// session — and only the 3-minute idle timer would eventually reap it.
//
// SIGTERM first so the CLI can flush + exit cleanly, then SIGKILL after a short grace if
// it's still alive. Returns a detach() to drop the listener once the child exits normally.
//
// THE SIGNAL MUST REACH THE GRANDCHILDREN. An agent CLI is not one process: codex runs shell
// commands, claude runs tools, and each of those is a child of the child. `child.kill()`
// signals exactly one pid, so Stop killed the CLI and left its shell running — a user pressed
// Stop, watched the panel go quiet, and found the process still going.
//
// Signalling the process GROUP fixes that, and only works if the child leads a group of its
// own — which is what spawnGroupOpts is for. Without that spawn option the child sits in the
// bridge's own group, and a group kill would signal the bridge.

/**
 * Spawn options that make a child its own process-group leader, so the whole tree can be
 * signalled together. No-op on Windows, which has no process groups in this sense — there
 * the taskkill fallback in killTree covers it.
 */
export const spawnGroupOpts = process.platform === 'win32' ? {} : { detached: true };

/**
 * Every pid descended from `pid`, snapshotted from the process table.
 *
 * A process-group kill is not enough on its own. codex runs each shell step in its OWN
 * process group (`sleep 90` came back with PGID == its own pid), so signalling the group we
 * created deliberately misses it — and once its parent dies it reparents to init, where
 * nothing connects it to the run that started it.
 *
 * So the tree is read BEFORE anything is signalled. Afterwards the links are gone.
 */
function descendantsOf(pid) {
  if (!pid || process.platform === 'win32') return [];
  let table = '';
  try {
    table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 2000 });
  } catch { return []; }
  const kids = new Map();
  for (const line of table.split('\n')) {
    const [p, pp] = line.trim().split(/\s+/).map(Number);
    if (!p || !pp) continue;
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  const out = [];
  const walk = (root, depth = 0) => {
    // A depth cap rather than a visited set: the table is a snapshot of a tree, and a cycle
    // would mean the kernel lied. The cap is there so a malformed read cannot hang a Stop.
    if (depth > 20) return;
    for (const k of kids.get(root) || []) { out.push(k); walk(k, depth + 1); }
  };
  walk(pid);
  return out;
}

/** Signal a child and everything it spawned. Falls back to the single process. */
function killTree(child, sig, known = []) {
  if (!child?.pid) return;
  // Descendants first, while the parent is still alive to be traced through. Orphaned
  // grandchildren are the ones the user cannot find or stop afterwards.
  for (const pid of known.length ? known : descendantsOf(child.pid)) {
    try { process.kill(pid, sig); } catch { /* already gone */ }
  }
  try {
    // Negative pid = the whole group. Only valid for a detached child; the catch covers a
    // child spawned without it, which is still better killed alone than not at all.
    process.kill(-child.pid, sig);
    return;
  } catch { /* not a group leader, or already gone */ }
  try { child.kill(sig); } catch { /* already exited */ }
}

export function killOnAbort(child, signal, { graceMs = 1500 } = {}) {
  if (!signal || !child) return () => {};
  const onAbort = () => {
    // Snapshot ONCE, up front: by the time the grace period expires the parent is gone and
    // the tree cannot be walked, so the escalation would have nothing left to aim at.
    const tree = descendantsOf(child.pid);
    killTree(child, 'SIGTERM', tree);
    const t = setTimeout(() => killTree(child, 'SIGKILL', tree), graceMs);
    if (t.unref) t.unref(); // don't keep the event loop alive just for the grace timer
  };
  if (signal.aborted) { onAbort(); return () => {}; }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } };
}
