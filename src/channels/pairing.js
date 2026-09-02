// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/pairing.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// Pairing — who may drive an agent from a phone, and how far their requests may travel.
//
// This is the AUTHENTICATION half of §7: it proves WHO sent a message (Telegram authenticates
// the sender's chat id; a one-time code makes enrollment deliberate, not silent). It says
// nothing about WHAT a message may do — a paired-but-injected message is still injected, so
// `reach` is a ceiling, never a licence. Tool authorization is the next layer up.
//
// Reach reuses the router's tiers verbatim (device < trusted < any), so "a paired phone is
// trusted" means the exact same thing here as it does to the model router downstream.

import { REACH } from '../events/reach.js';

export { REACH };

// 6 digits: enough entropy for a short-lived, single-use enrollment code shown on a screen,
// short enough to thumb into a phone. It is NOT a password — it expires and burns on first use.
function sixDigits(randomInt) {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * A pairing store over a plain-JSON state object, with clock and RNG injected so enrollment
 * is deterministic in tests. Persistence is the caller's job: load the JSON at start, call
 * toJSON() after a mutation, write it back — the same shape as pii's createVault/vaultToJSON.
 *
 *   state: { paired: { [actorId]: { reach, at } }, pending: { [code]: { at, ttlMs } } }
 */
export function createPairingStore(state = {}, {
  now = () => Date.now(),
  randomInt = (min, max) => min + Math.floor(Math.random() * (max - min)),
} = {}) {
  const paired = new Map(Object.entries(state.paired || {}));
  const pending = new Map(Object.entries(state.pending || {}));

  const prune = () => {
    const t = now();
    for (const [code, p] of pending) if (t - p.at > (p.ttlMs || 0)) pending.delete(code);
  };

  return {
    /** Owner-side: mint a one-time code to read out to the phone. Shown in the extension/CLI. */
    requestCode({ ttlMs = 10 * 60_000 } = {}) {
      prune();
      let code;
      do { code = sixDigits(randomInt); } while (pending.has(code));
      pending.set(code, { at: now(), ttlMs });
      return code;
    },
    /** Phone-side: "/pair 123456". Burns the code and pairs the actor at 'trusted'. */
    redeem(actorId, code, { reach = 'trusted' } = {}) {
      prune();
      const c = String(code || '').trim();
      if (!pending.has(c)) return { ok: false, reason: 'unknown or expired code' };
      if (!REACH.includes(reach)) return { ok: false, reason: `unknown reach '${reach}'` };
      pending.delete(c);
      paired.set(actorId, { reach, at: now() });
      return { ok: true, reach };
    },
    /** Bootstrap without a code — for an operator-supplied allow list. Explicit, not silent. */
    allow(actorId, { reach = 'trusted' } = {}) {
      if (!REACH.includes(reach)) throw new Error(`unknown reach '${reach}'`);
      paired.set(actorId, { reach, at: now() });
    },
    revoke(actorId) { return paired.delete(actorId); },
    isPaired(actorId) { return paired.has(actorId); },
    /** The reach ceiling for this actor, or null when it isn't paired (→ refuse the message). */
    reachOf(actorId) { return paired.get(actorId)?.reach || null; },
    list() { return [...paired.entries()].map(([id, v]) => ({ actorId: id, ...v })); },
    toJSON() { return { paired: Object.fromEntries(paired), pending: Object.fromEntries(pending) }; },
  };
}
