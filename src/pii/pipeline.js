// GENERATED — do not edit.
// Source of truth: chatpanel-pii/pipeline.js (npm @chatpanel/pii).
// Edit there, then run: npm run sync:pii
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve.

// Pure turn-level orchestration shared by every ChatPanel surface (extension,
// gateway, bridge). It composes the deterministic engine (pii-redact.js) into the
// message pipeline and applies the tier / scope / dictionary gating.
//
// What lives HERE (portable): redactOutbound, redactToolResult/redactResult,
// makeStreamRestorer, restore/restoreDeep, effectiveTier + gating.
//
// Host glue kept in the EXTENSION (NOT here): reading settings.ui.piiRedaction,
// the entitlement flag, and chrome storage — those wrap these pure functions with
// host-specific config.

import { redactText, restoreText, restoreWithAliases, redactResultShape } from './pii-redact.js';

export function redactionEnabled(cfg) {
  return !!(cfg && cfg.mode && cfg.mode !== 'off');
}

// The entity (name/org) tier is Pro; Free falls back to the deterministic regex tier.
export function effectiveTier(cfg, isPro) {
  const t = cfg?.tier === 'full' ? 'full' : 'basic';
  return t === 'full' && !isPro ? 'basic' : t;
}

// On Free the first FREE_DICT_LIMIT custom-dictionary entries apply; the full
// dictionary is Pro. Enforced here as well as in the UI.
export const FREE_DICT_LIMIT = 5;

export function gatedDictionary(cfg, isPro) {
  const d = Array.isArray(cfg?.dictionary) ? cfg.dictionary : [];
  return isPro ? d : d.slice(0, FREE_DICT_LIMIT);
}

export function gatedScope(cfg, isPro) {
  const s = cfg?.scope || {};
  if (isPro) return s;
  return { chat: s.chat !== false, context: false, history: false, toolResults: false };
}

export function redactOpts(cfg, isPro, entities) {
  return {
    tier: effectiveTier(cfg, isPro),
    entities: entities || [],
    dictionary: gatedDictionary(cfg, isPro),
  };
}

// Returns redacted COPIES — never mutates the stored conversation.
export function redactOutbound({ messages, system, vault, cfg, isPro = false, entities = [] }) {
  if (!redactionEnabled(cfg) || !vault) return { messages, system };
  const opts = redactOpts(cfg, isPro, entities);
  const scope = gatedScope(cfg, isPro);
  const redactMsg = (m) => {
    const copy = { ...m };
    if (scope.chat !== false && m.content) copy.content = redactText(m.content, vault, opts);
    if (Array.isArray(m.attachments)) {
      copy.attachments = m.attachments.map((a) => {
        if (a.kind === 'image' || !a.text) return a;
        const isHistory = a.kind === 'history-rag';
        if (isHistory ? scope.history === false : scope.context === false) return a;
        return { ...a, text: redactText(a.text, vault, opts) };
      });
    }
    return copy;
  };
  return {
    messages: (messages || []).map(redactMsg),
    system: system ? redactText(system, vault, opts) : system,
  };
}

export function redactToolResult(text, { vault, cfg, isPro = false, entities = [] } = {}) {
  if (!redactionEnabled(cfg) || !vault || !gatedScope(cfg, isPro).toolResults) return text;
  if (typeof text !== 'string') return text;
  return redactText(text, vault, redactOpts(cfg, isPro, entities));
}

// Streaming-safe restorer. push() returns text safe to display now; flush() the rest.
export function makeStreamRestorer(vault) {
  let buf = '';
  return {
    push(chunk) {
      if (!vault) return chunk || '';
      buf += chunk || '';
      const open = buf.lastIndexOf('[[');
      let safe;
      if (open !== -1 && !buf.slice(open).includes(']]')) {
        safe = buf.slice(0, open);
        buf = buf.slice(open);
      } else {
        safe = buf;
        buf = '';
      }
      return restoreText(safe, vault);
    },
    flush() {
      const out = vault ? restoreText(buf, vault) : buf;
      buf = '';
      return out;
    },
  };
}

export function restore(text, vault) {
  return vault ? restoreText(text, vault) : text;
}

// Deep-restore a value (tool-call args contain tokens; local tools must run on the
// REAL values). restoreWithAliases undoes pseudonyms too — local lookups hit real
// data; only the model stays blinded.
export function restoreDeep(value, vault) {
  if (!vault) return value;
  if (typeof value === 'string') return restoreWithAliases(value, vault);
  if (Array.isArray(value)) return value.map((v) => restoreDeep(v, vault));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = restoreDeep(value[k], vault);
    return out;
  }
  return value;
}

// Re-redact a tool result of any shape (string / { text } / array / MCP
// { content:[{text}] }), gated once by the toolResults scope. The old path only
// covered string + { text }, so PII in a content[] item reached the model.
export function redactResult(result, ctx) {
  const { vault, cfg, isPro = false, entities = [] } = ctx || {};
  if (!redactionEnabled(cfg) || !vault || !gatedScope(cfg, isPro).toolResults) return result;
  return redactResultShape(result, vault, redactOpts(cfg, isPro, entities));
}
