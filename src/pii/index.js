// GENERATED — do not edit.
// Source of truth: chatpanel-pii/index.js (npm @chatpanel/pii).
// Edit there, then run: npm run sync:pii
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve.

// chatpanel-pii — the canonical ChatPanel privacy engine. Single source of truth
// for reversible PII redaction + pseudonymization, shared by the extension, the
// gateway, and the bridge. Pure + dependency-free ESM.
//
//   import { createVault, redactText, restoreText, detectEntities } from 'chatpanel-pii';
//
// Submodules are also importable directly:
//   'chatpanel-pii/pii-redact.js'   deterministic redact/restore + vault
//   'chatpanel-pii/pii-detect.js'   local NER / LLM entity detection
//   'chatpanel-pii/pipeline.js'     pure turn orchestration + tier/scope selection
//   'chatpanel-pii/tool-rank.js'    deterministic tool narrowing (auto mode)
//   'chatpanel-pii/sanitize.js'     Unicode de-steganography (strip invisible/format chars)
//   'chatpanel-pii/net.js'          SSRF host classifier + outbound-URL guard

export * from './pii-redact.js';
export * from './pii-detect.js';
export * from './pipeline.js';
export * from './tool-rank.js';
export * from './tool-harness.js';
export * from './sanitize.js';
export * from './net.js';
