// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/invoke.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// The invariant core: an inbound message becomes ONE capability invocation with
// actor.kind:'channel', its text is redacted before it can leave for the agent, and both facts
// are written to the event log. Everything here is pure given a vault + an appender — the
// adapter owns the network, this owns the contract.

import { validateInvocation } from '../events/capability.js';
import { createVault, redactText, restoreText, redactionSummary } from '../pii/index.js';

// One capability every channel message invokes: "run an agent turn on the user's behalf".
// Effects are non-replayable — a turn runs shell/filesystem tools, so replaying it would
// repeat side effects; that is exactly why validateInvocation demands an idempotencyKey.
export const CHANNEL_CAPABILITY = 'channel.chat';
export const CHANNEL_EFFECTS = 'non-replayable';

/** Build + validate the invocation for one inbound message. Throws EventError on a bad shape. */
export function buildInvocation({ platform, chatId, messageId }, causes = []) {
  const id = `${platform}:${chatId}`;
  const inv = {
    capability: CHANNEL_CAPABILITY,
    actor: { kind: 'channel', id },
    scope: { kind: 'session', id },
    causes,
    effects: CHANNEL_EFFECTS,
    // Same platform + chat + message = same turn. Retried delivery must not run it twice.
    idempotencyKey: `${platform}:${chatId}:${messageId}`,
  };
  return validateInvocation(inv);
}

// Entries per entity type in a vault, so we can diff before/after and report how many NEW
// values a turn redacted — never the values (privacy.redacted is counts-only, by contract).
function countsByType(vault) {
  const counts = {};
  for (const t of redactionSummary(vault).types) counts[t.type] = t.count;
  return counts;
}

/**
 * Redact inbound text into the chat's vault. Returns the redacted text plus the per-turn
 * counts delta (for a privacy.redacted event). The vault persists across turns, so PERSON_1
 * means the same person every message.
 *
 * `tier:'basic'` (regex: emails, phones, cards, keys, IPs) is the safe default with no roster;
 * pass `tier:'full'` + `entities` to also pseudonymize known people/orgs.
 */
export function redactInbound(text, vault, { tier = 'basic', entities = [], dictionary = [] } = {}) {
  const before = countsByType(vault);
  const redacted = redactText(text ?? '', vault, { tier, entities, dictionary });
  const after = countsByType(vault);
  const counts = {};
  for (const type of Object.keys(after)) {
    const d = after[type] - (before[type] || 0);
    if (d > 0) counts[type] = d;
  }
  return { redacted, counts };
}

/**
 * Restore the agent's reply for the user. Two honest modes:
 *  - 'standard' (default): swap placeholders back to real values. The user reads their own
 *    data on their own phone — but Telegram/Meta bot traffic is NOT end-to-end encrypted, so
 *    the provider carries it in the clear. That is the accepted trade for a readable reply.
 *  - 'strict': leave placeholders in the outbound message. The provider never sees a real
 *    value; the user sees [[PERSON_1]]. Choose per deployment.
 */
export function restoreOutbound(text, vault, { privacy = 'standard' } = {}) {
  return privacy === 'strict' ? String(text ?? '') : restoreText(text ?? '', vault);
}

// A [[TYPE_n]] placeholder token; the capture is the entity TYPE.
const TOKEN_MARKER_RE = /\[\[([A-Z][A-Z0-9]*)_\d+\]\]/g;

// Hard credentials: catastrophic if they reach a third-party provider, and a user practically
// never types their own into a chat — so we mask these on EVERY egress regardless of privacy
// mode. Contact PII (EMAIL/PHONE/IP) is deliberately NOT here: re-masking it would gut standard
// mode (the user could never read their own data back), so it follows the privacy mode instead.
export const EGRESS_SECRET_TYPES = new Set(['SECRET', 'KEY', 'CARD', 'SSN']);

/**
 * EGRESS SCRUB. Inbound redaction only covers the user's typed message — but the agent can
 * surface a NEW secret the vault never saw: a key/token/card it read from a file or a tool and
 * echoed into the reply. The reply itself is an egress to a provider (Telegram/Meta) that is NOT
 * end-to-end encrypted, so that fresh secret would transit in the clear. This runs a fresh
 * detector pass into a THROWAWAY vault and permanently masks the hard-credential types to a
 * readable '‹type redacted›' marker.
 *
 * Run this AFTER restore: at that point no real chat-vault tokens remain, so the single throwaway
 * vault numbers cleanly (no [[TYPE_n]] collision) and non-secret detections can be re-expanded to
 * the value the user is allowed to read. `restoreNonSecret:false` (strict mode) keeps everything
 * tokenized so no real value — fresh or otherwise — is emitted.
 */
export function scrubEgress(text, { secretTypes = EGRESS_SECRET_TYPES, restoreNonSecret = true } = {}) {
  if (text == null || text === '') return text ?? '';
  const tv = createVault();
  const masked = redactText(String(text), tv, { tier: 'basic' });
  return masked.replace(TOKEN_MARKER_RE, (full, type) => {
    if (secretTypes.has(type.toUpperCase())) return `‹${type.toLowerCase()} redacted›`;
    return restoreNonSecret ? (tv.byToken.get(full) ?? full) : full;
  });
}

/**
 * The single outbound transform: what to actually SEND to the provider for one reply.
 *  - 'standard': restore the user's own values (they read their own data back), THEN scrub — so
 *    contact PII the user typed survives, but any hard credential the agent surfaced is masked.
 *  - 'strict': keep the user's values as placeholders AND still mask fresh credentials, so
 *    'strict' is never weaker than 'standard'.
 */
export function outboundText(text, vault, { privacy = 'standard' } = {}) {
  const restored = restoreOutbound(text, vault, { privacy });
  return scrubEgress(restored, { restoreNonSecret: privacy !== 'strict' });
}

// Conversation memory. The adapter keeps ONE array of REDACTED turns per chat and replays it
// as context, so "…and the second one?" resolves against the prior answer. The bridge's
// buildCliPrompt already renders all-but-last as a labelled history transcript and the last as
// the live message — so multi-turn just works once the array is threaded through.
//
// We store the redacted user text and the agent's (already-placeholdered) reply — never real
// values — so history is exactly as safe to hold as the event log, and the vault stays the one
// source of truth for what PERSON_1 means. The window is bounded so a long chat can't grow the
// prompt without end.
export const DEFAULT_HISTORY_MESSAGES = 16;

/**
 * Append one exchange to a chat's history and return the new, bounded array (never mutates).
 * `assistantText` is optional — a failed turn stores nothing, so history never implies the
 * agent answered when it didn't.
 */
export function appendTurn(history, userText, assistantText, { maxMessages = DEFAULT_HISTORY_MESSAGES } = {}) {
  const next = Array.isArray(history) ? history.slice() : [];
  next.push({ role: 'user', content: String(userText ?? '') });
  const reply = assistantText == null ? '' : String(assistantText);
  if (reply) next.push({ role: 'assistant', content: reply });
  // Keep only the last maxMessages, and never let the window open on an assistant turn — a
  // transcript that starts with "Assistant:" reads as if the agent spoke first.
  let windowed = maxMessages > 0 ? next.slice(-maxMessages) : next;
  while (windowed.length && windowed[0].role === 'assistant') windowed = windowed.slice(1);
  return windowed;
}

// Event builders — thin, so the adapter appends without knowing payload shapes. Each returns
// whatever the appender's append() returns (a validated event, or a promise of one).
export function appendInvoked(appender, invocation, causes = []) {
  return appender.append('capability.invoked', {
    capability: invocation.capability,
    actor: invocation.actor,
    scope: invocation.scope,
    effects: invocation.effects,
    idempotencyKey: invocation.idempotencyKey,
  }, causes);
}

export function appendRedacted(appender, counts, causes = []) {
  // Nothing redacted → nothing to record. An empty privacy.redacted still validates, but a
  // log line that says "0 of nothing" is noise.
  if (!counts || !Object.keys(counts).length) return null;
  return appender.append('privacy.redacted', { counts }, causes);
}

export function appendEgress(appender, { host, redacted, controlled }, causes = []) {
  return appender.append('privacy.egress', { host, redacted: !!redacted, controlled: !!controlled }, causes);
}
