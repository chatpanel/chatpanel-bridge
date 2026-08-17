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

/** Signal a child and everything it spawned. Falls back to the single process. */
function killTree(child, sig) {
  if (!child?.pid) return;
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
    killTree(child, 'SIGTERM');
    const t = setTimeout(() => killTree(child, 'SIGKILL'), graceMs);
    if (t.unref) t.unref(); // don't keep the event loop alive just for the grace timer
  };
  if (signal.aborted) { onAbort(); return () => {}; }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } };
}
