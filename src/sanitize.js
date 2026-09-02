// The Unicode sanitizer, from the one engine that owns it.
//
// This file used to be a HAND copy of chatpanel-pii/sanitize.js, kept in step by memory — the
// exact drift the vendoring scripts exist to prevent. The engine is now vendored properly under
// src/pii/ (npm run sync:pii, with a --check drift guard), so this is a re-export and there is
// only one copy in the repo to diverge from. Existing importers are unchanged.
export { hasHiddenChars, sanitizeUnicode, stripHidden, SANITIZE_RANGES } from './pii/sanitize.js';
