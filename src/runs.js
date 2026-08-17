// Every in-flight run, so Stop is an INSTRUCTION rather than an inference.
//
// Cancellation used to depend on Node noticing the client's socket close and firing
// `req.on('close')`. That is a signal about a socket, not about intent: it can arrive late,
// and on a request whose body was already consumed it does not reliably arrive at all — so
// a codex `shell:` step ran on for minutes after Stop with nothing left listening to it.
//
// A run registered here can be cancelled by name. The socket-close path stays as a safety
// net for a panel that is closed or crashes, but the button no longer depends on it.
const runs = new Map();

export function startRun(id) {
  const ac = new AbortController();
  const children = new Set();
  const run = {
    id,
    signal: ac.signal,
    // Children are tracked as well as signalled, because an agent that spawns sub-agents
    // spawns processes this module never sees at spawn time. Whoever creates one registers
    // it, and Stop reaches all of them.
    track(child) { if (child?.pid) { children.add(child); child.once?.('exit', () => children.delete(child)); } },
    cancel(reason = 'stopped') {
      if (run.cancelled) return false;
      run.cancelled = reason;
      ac.abort();
      return true;
    },
    cancelled: null,
    children,
  };
  runs.set(id, run);
  return run;
}

export function endRun(id) { runs.delete(id); }

export function cancelRun(id, reason = 'stopped') {
  const run = runs.get(id);
  return run ? run.cancel(reason) : false;
}

/** Used on shutdown: leaving a CLI running after the bridge exits is how orphans are made. */
export function cancelAll(reason = 'shutdown') {
  let n = 0;
  for (const run of runs.values()) if (run.cancel(reason)) n += 1;
  return n;
}

export const activeRuns = () => runs.size;
