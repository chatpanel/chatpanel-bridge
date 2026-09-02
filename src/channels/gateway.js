// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/gateway.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// Gateway backend: reach ANY configured destination — an API provider or a CLI agent —
// through the ChatPanel gateway's OpenAI-compatible endpoint.
//
//   channel  →  POST http://127.0.0.1:4320/v1/chat/completions  { model, messages, stream }
//
// WHY THIS EXISTS ALONGSIDE bridge.js. The bridge runs CLI agents, and that is all it can
// answer with — so a phone could only ever talk to Claude Code or Codex, never to the OpenAI,
// Anthropic or local-model endpoints the same user already configured. Those live in the
// gateway, which persists its `destinations` (0600, keys included) and routes a model id to
// an API provider OR back to the bridge for an agent. So the gateway is the superset, and
// pointing a channel at it is what makes "answer from my phone" work with every target the
// user has rather than a subset.
//
// NO NEW SECRET. The alternative was teaching the bridge to hold provider API keys, which
// would have put them on disk a second time, in a second format, with a second thing to
// rotate. The gateway already holds them and already guards them; this borrows the routing
// instead of copying the credentials.
//
// The /v1 data plane is deliberately unauthenticated for local clients — that is the
// gateway's product — so there is no token to present here, and none to leak.

import { parseSse, foldOpenAiEvent, initialState } from './stream.js';

// Per-turn aborts, so /stop can cancel a gateway turn the way it cancels a bridge run. The
// bridge hands out a run id for this; OpenAI's API has no such handle, so we mint one and
// keep the controller behind it rather than leaving /stop silently broken on this transport.
const inflight = new Map();

/**
 * Drive one turn against a gateway destination. Same shape as bridge.chat so the adapter does
 * not know which transport it has: streams events to onEvent(ev, state) and returns the folded
 * final state.
 */
export async function chat({ model = '', system = '', messages = [], options = {} }, {
  baseUrl, signal, onEvent = () => {},
} = {}) {
  const runId = `gw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const ac = new AbortController();
  inflight.set(runId, ac);
  // The caller's signal (the poll loop shutting down) must still abort the turn.
  const relay = () => ac.abort();
  signal?.addEventListener?.('abort', relay, { once: true });

  let state = initialState();
  const emit = (ev) => { state = foldOpenAiEvent(state, ev); onEvent(ev, state); };
  emit({ type: 'run', id: runId });

  try {
    const res = await fetch(`${String(baseUrl).replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          ...messages.map((m) => ({ role: m.role, content: String(m.content ?? '') })),
        ],
        // Carried through so a capped phone's reach still reaches the router. The gateway
        // ignores what it does not know, which is what keeps an older gateway working.
        ...(options?.reach ? { chatpanel: { reach: options.reach } } : {}),
      }),
      signal: ac.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`gateway ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      const { events, rest } = parseSse(buffer);
      buffer = rest;
      for (const ev of events) emit(ev);
    }
    // OpenAI streams end with `data: [DONE]`, which is not JSON and is dropped by parseSse —
    // so a stream that ended cleanly still has to be marked done here.
    if (!state.done) state = { ...state, done: true };
    return state;
  } catch (e) {
    if (ac.signal.aborted) return { ...state, done: true };
    return { ...state, done: true, error: e?.message || String(e) };
  } finally {
    inflight.delete(runId);
    signal?.removeEventListener?.('abort', relay);
  }
}

/** Stop a run by the id emitted as the first {type:'run'} event. Best-effort, like the bridge's. */
export async function cancel(runId) {
  const ac = runId && inflight.get(runId);
  if (!ac) return false;
  ac.abort();
  inflight.delete(runId);
  return true;
}
