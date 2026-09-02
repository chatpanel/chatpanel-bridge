#!/usr/bin/env node
// Vendors the redaction engine the channel service needs from `chatpanel-pii`.
//
// The bridge ships ZERO runtime dependencies on purpose — it installs by curl one-liner and
// compiles to a single binary, and every dependency is something that can fail on a stranger's
// laptop. So the engine arrives the way the event contracts do: copied in, generated, never
// hand-edited.
//
//   node scripts/sync-pii.mjs           refresh src/pii/ from the package
//   node scripts/sync-pii.mjs --check   verify it matches (drift guard); exit 1 if not
//
// This is also what retires the oldest hand-copy in the repo: `src/sanitize.js` used to be a
// manual copy of the same engine's sanitizer, kept in step by memory. It is now a two-line
// re-export of the vendored copy, so there is one file to diverge from and a test that notices.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The whole engine, because redaction is not a subset you can take half of: `index.js` is the
// entry the channel core imports, and every file below it is on that graph.
const FILES = [
  'index.js', 'pii-redact.js', 'pii-detect.js', 'pipeline.js',
  'tool-rank.js', 'tool-harness.js', 'sanitize.js', 'net.js',
];

function pkgDir() {
  return [
    join(ROOT, 'node_modules', '@chatpanel', 'pii'),
    join(ROOT, '..', 'chatpanel-pii'),
  ].find((d) => existsSync(join(d, 'pii-redact.js')));
}

const check = process.argv.includes('--check');
const src = pkgDir();

if (!src) {
  const msg = 'chatpanel-pii not found (check out ../chatpanel-pii).';
  if (check) { console.error(`sync-pii --check: ${msg}`); process.exit(1); }
  console.warn(`sync-pii: ${msg} Leaving src/pii as-is.`);
  process.exit(0);
}

const outDir = join(ROOT, 'src', 'pii');
if (!check) mkdirSync(outDir, { recursive: true });

const banner = (f) => `// GENERATED — do not edit.\n`
  + `// Source of truth: chatpanel-pii/${f} (npm @chatpanel/pii).\n`
  + `// Edit there, then run: npm run sync:pii\n`
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
  if (check) { console.error(`sync-pii --check: src/pii/${f} differs from chatpanel-pii`); drift += 1; continue; }
  writeFileSync(dest, want);
  console.log(`sync-pii: updated src/pii/${f}`);
}

if (check) {
  if (drift) { console.error('Run `npm run sync:pii` and commit the result.'); process.exit(1); }
  console.log('sync-pii --check: src/pii matches chatpanel-pii ✓');
}
