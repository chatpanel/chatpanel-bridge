#!/usr/bin/env node
// Vendors the shared contracts the bridge needs from `chatpanel-events`.
//
// The bridge has ZERO runtime dependencies on purpose — it is installed by a curl
// one-liner and compiled into a single binary, and every dependency is a thing that can
// fail at install time on someone's laptop. So shared contracts arrive the way
// @chatpanel/pii does: copied in, generated, never hand-edited.
//
//   node scripts/sync-events.mjs           refresh src/events/ from the package
//   node scripts/sync-events.mjs --check   verify they match (CI drift guard); exit 1 if not
//
// A hand-copy is how `sanitize.js` could silently diverge from the engine it came from.
// This makes divergence a failing test instead of a bug report.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Deliberately short. `skill-manifest.js` imports only `scopes.js`, which is why that
// vocabulary was split out of `capability.js` — vendoring the capability machinery and
// the event schema to reach a five-element array would defeat the point.
const FILES = ['scopes.js', 'skill-manifest.js'];

function pkgDir() {
  return [
    join(ROOT, 'node_modules', '@chatpanel', 'events'),
    join(ROOT, '..', 'chatpanel-events'),
  ].find((d) => existsSync(join(d, 'skill-manifest.js')));
}

const check = process.argv.includes('--check');
const src = pkgDir();

if (!src) {
  const msg = 'chatpanel-events not found (check out ../chatpanel-events).';
  if (check) { console.error(`sync-events --check: ${msg}`); process.exit(1); }
  console.warn(`sync-events: ${msg} Leaving src/events as-is.`);
  process.exit(0);
}

const outDir = join(ROOT, 'src', 'events');
if (!check) mkdirSync(outDir, { recursive: true });

const banner = (f) => `// GENERATED — do not edit.\n`
  + `// Source of truth: chatpanel-events/${f} (npm @chatpanel/events).\n`
  + `// Edit there, then run: npm run sync:events\n`
  + `//\n`
  + `// Vendored rather than depended on: the bridge ships zero runtime dependencies so a\n`
  + `// curl one-liner install cannot fail on someone's registry, and so the compiled\n`
  + `// single-file binary has nothing to resolve.\n\n`;

let drift = 0;
for (const f of FILES) {
  const want = banner(f) + readFileSync(join(src, f), 'utf8');
  const dest = join(outDir, f);
  const have = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  if (have === want) continue;
  if (check) { console.error(`sync-events --check: src/events/${f} differs from chatpanel-events`); drift += 1; continue; }
  writeFileSync(dest, want);
  console.log(`sync-events: updated src/events/${f}`);
}

if (check) {
  if (drift) { console.error('Run `npm run sync:events` and commit the result.'); process.exit(1); }
  console.log('sync-events --check: src/events matches chatpanel-events ✓');
}
