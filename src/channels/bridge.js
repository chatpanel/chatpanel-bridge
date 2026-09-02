// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/bridge.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// The transport to the local agent: POST /chat (SSE) and POST /cancel on the bridge. The
// bridge binds 127.0.0.1:4319 and runs Claude Code / Codex / etc. as CLIs — so this is the ONE
// hop where the (already-redacted) conversation reaches the agent, and it never leaves the
// machine. A channel adapter is a non-browser local client, so it presents the per-install
// bridge token, exactly like any privileged caller.

import { parseSse, foldEvent, initialState } from './stream.js';

/**
 * Drive one turn. Streams bridge events to onEvent(ev, state) as they arrive AND folds them
 * into a final reply state it returns. `agent` is a bridge engine id ('claude','codex',…).
 */
export async function chat({ agent = 'claude', system = '', messages, images = [], options = {} }, {
  baseUrl, token, signal, onEvent = () => {},
} = {}) {
  const res = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent, system, messages, images, options }),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`bridge /chat ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
  }
  let state = initialState();
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    const { events, rest } = parseSse(buffer);
    buffer = rest;
    for (const ev of events) { state = foldEvent(state, ev); onEvent(ev, state); }
  }
  return state;
}

/** Stop a run by the id the bridge emitted as its first {type:'run'} event. Best-effort. */
export async function cancel(runId, { baseUrl, token } = {}) {
  if (!runId) return false;
  try {
    const res = await fetch(`${baseUrl}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: runId }),
    });
    const out = await res.json().catch(() => ({}));
    return !!out.cancelled;
  } catch { return false; }
}
