// Terminate a spawned CLI child when an AbortSignal fires. The extension's Stop
// button aborts the /chat request; server.js turns that disconnect into an abort on
// this signal. Without this, the agent CLI (codex / claude / agy / custom) keeps
// running to completion in the background after Stop — burning tokens and holding the
// session — and only the 3-minute idle timer would eventually reap it.
//
// SIGTERM first so the CLI can flush + exit cleanly (its own child procs get the
// signal via the process group where the platform delivers it), then SIGKILL after a
// short grace if it's still alive. Returns a detach() to drop the listener once the
// child exits normally.
export function killOnAbort(child, signal, { graceMs = 1500 } = {}) {
  if (!signal || !child) return () => {};
  const onAbort = () => {
    try { child.kill('SIGTERM'); } catch { /* already exited */ }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, graceMs);
    if (t.unref) t.unref(); // don't keep the event loop alive just for the grace timer
  };
  if (signal.aborted) { onAbort(); return () => {}; }
  signal.addEventListener('abort', onAbort, { once: true });
  return () => { try { signal.removeEventListener('abort', onAbort); } catch { /* noop */ } };
}
