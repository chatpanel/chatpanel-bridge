// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/stream.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// The model's reply, assembled from the bridge's SSE stream — PURE so accumulation and the
// token-restore boundary are testable without a socket. Per chatpanel-bridge /chat, the bridge
// emits `data: <json>\n\n` frames of:
//   {type:'run', id}       a cancel-by-name handle, emitted first
//   {type:'workdir'|'status'|'reasoning'|'tool', ...}  progress a caller MAY show
//   {type:'delta', text}   incremental assistant text
//   {type:'done', text?}   text only when it wasn't streamed
//   {type:'error', error}
// We only need run/delta/done/error to build a reply.

export function initialState() {
  return { runId: null, text: '', status: '', error: null, done: false };
}

/** Fold one bridge event into the running reply. Returns a NEW state (never mutates). */
export function foldEvent(state, ev) {
  switch (ev?.type) {
    case 'run': return { ...state, runId: ev.id || state.runId };
    case 'delta': return { ...state, text: state.text + (ev.text || '') };
    case 'status': return { ...state, status: ev.text || state.status };
    // A `done` may carry the whole text (engines that don't stream). Only take it when we
    // streamed nothing, or the reply doubles.
    case 'done': return { ...state, done: true, text: (!state.text && ev.text) ? ev.text : state.text };
    case 'error': return { ...state, done: true, error: ev.error || 'unknown error' };
    default: return state;
  }
}

/**
 * Fold one OpenAI-style chunk (what the gateway streams) into the same reply state, so a
 * caller cannot tell which transport it has. Shares parseSse: `data: [DONE]` is not JSON and
 * is dropped there, which is why the transport marks `done` itself when the stream ends.
 */
export function foldOpenAiEvent(state, ev) {
  if (ev?.type === 'run') return { ...state, runId: ev.id || state.runId };
  // An error can arrive as a streamed frame rather than an HTTP status.
  if (ev?.error) return { ...state, done: true, error: ev.error.message || String(ev.error) };
  const choice = ev?.choices?.[0];
  let next = state;
  const delta = choice?.delta?.content;
  if (typeof delta === 'string' && delta) next = { ...next, text: next.text + delta };
  // Non-streaming replies (a gateway destination that cannot stream) carry the whole message.
  const whole = choice?.message?.content;
  if (!next.text && typeof whole === 'string' && whole) next = { ...next, text: whole };
  if (choice?.finish_reason) next = { ...next, done: true };
  return next;
}

/**
 * Pull complete SSE events out of a growing buffer. Returns the parsed events and the
 * UNCONSUMED tail (a partial frame still arriving), which the caller prepends next read.
 */
export function parseSse(buffer) {
  const events = [];
  let rest = String(buffer);
  let idx;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const raw = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try { events.push(JSON.parse(json)); } catch { /* skip a malformed frame */ }
    }
  }
  return { events, rest };
}

// Telegram rejects a message body over 4096 chars. Split on paragraph, then line, then a hard
// cut, so a long answer arrives as several messages instead of one API error.
export function splitForTelegram(text, max = 4096) {
  let s = String(text ?? '');
  const out = [];
  while (s.length > max) {
    let cut = s.lastIndexOf('\n\n', max);
    if (cut < max * 0.5) cut = s.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(s.slice(0, cut));
    s = s.slice(cut).replace(/^\n+/, '');
  }
  if (s) out.push(s);
  return out.length ? out : [''];
}

// A minimal time gate for throttling live edits — Telegram allows ~1 edit/sec to a chat.
// `now` injected for tests. ready() returns true and advances only when `ms` has elapsed.
export function createGate(ms, { now = () => Date.now() } = {}) {
  // -Infinity, not 0, so the FIRST call always fires (replace the "…" placeholder promptly)
  // regardless of the clock's magnitude — then throttle. With last=0 this only worked because
  // the real Date.now() dwarfs `ms`; an injected test clock at t=0 exposed the latent bug.
  let last = -Infinity;
  return {
    ready() { const t = now(); if (t - last >= ms) { last = t; return true; } return false; },
    reset() { last = -Infinity; },
  };
}
