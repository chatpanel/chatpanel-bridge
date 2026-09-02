#!/usr/bin/env node
// Vendors the channel core from `chatpanel-channels`.
//
// WHY THE BRIDGE HOSTS IT. A messaging channel has to be running when nobody is looking — the
// whole point is to reach your machine from a phone while the browser is closed — and the
// bridge is the only always-on local process a ChatPanel user already has. Putting the loop
// anywhere else (a second daemon, an npm install, a service worker that Chrome suspends) is a
// second thing a non-technical person has to install and keep alive.
//
//   node scripts/sync-channels.mjs           refresh src/channels/ from the package
//   node scripts/sync-channels.mjs --check   verify it matches (drift guard); exit 1 if not
//
// The package imports `@chatpanel/pii` and `@chatpanel/events/*` by name; the bridge has no
// node_modules, so those specifiers are REWRITTEN to the vendored copies as the files are
// copied. The rewrite is table-driven and fails loudly on an unknown bare import rather than
// emitting a file that throws at runtime inside a compiled binary.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// The service and everything under it. `config.js` is deliberately absent: it resolves paths
// and reads the bridge token from disk, and the bridge already knows both.
const FILES = [
  'normalize.js', 'pairing.js', 'invoke.js', 'stream.js', 'bridge.js', 'gateway.js',
  'eventlog.js', 'service.js', 'adapters/telegram.js',
];

// bare specifier → path relative to src/channels/ (adjusted per file depth below).
const REWRITE = {
  '@chatpanel/pii': '../pii/index.js',
  '@chatpanel/events/event.js': '../events/event.js',
  '@chatpanel/events/capability.js': '../events/capability.js',
  '@chatpanel/events/reach.js': '../events/reach.js',
};

function pkgDir() {
  return [
    join(ROOT, 'node_modules', '@chatpanel', 'channels', 'src'),
    join(ROOT, '..', 'chatpanel-channels', 'src'),
  ].find((d) => existsSync(join(d, 'service.js')));
}

const check = process.argv.includes('--check');
const src = pkgDir();

if (!src) {
  const msg = 'chatpanel-channels not found (check out ../chatpanel-channels).';
  if (check) { console.error(`sync-channels --check: ${msg}`); process.exit(1); }
  console.warn(`sync-channels: ${msg} Leaving src/channels as-is.`);
  process.exit(0);
}

const banner = (f) => `// GENERATED — do not edit.\n`
  + `// Source of truth: chatpanel-channels/src/${f} (npm @chatpanel/channels).\n`
  + `// Edit there, then run: npm run sync:channels\n`
  + `//\n`
  + `// Vendored rather than depended on: the bridge ships zero runtime dependencies so a\n`
  + `// curl one-liner install cannot fail on someone's registry, and so the compiled\n`
  + `// single-file binary has nothing to resolve. Package imports are rewritten to the\n`
  + `// vendored engines (src/pii, src/events) by the sync script.\n\n`;

// Rewrite every bare @chatpanel specifier, and refuse to emit a file with one left over.
function vendor(file, text) {
  const up = '../'.repeat(file.split('/').length - 1); // adapters/telegram.js sits one deeper
  let out = text.replace(/(from\s+['"])(@chatpanel\/[^'"]+)(['"])/g, (full, a, spec, b) => {
    const to = REWRITE[spec];
    if (!to) throw new Error(`sync-channels: no rewrite for '${spec}' (imported by ${file}) — add it to REWRITE`);
    return `${a}${up}${to}${b}`;
  });
  const left = out.match(/from\s+['"]@chatpanel\/[^'"]+['"]/);
  if (left) throw new Error(`sync-channels: unrewritten import in ${file}: ${left[0]}`);
  return banner(file) + out;
}

let drift = 0;
for (const f of FILES) {
  const want = vendor(f, readFileSync(join(src, f), 'utf8'));
  const dest = join(ROOT, 'src', 'channels', f);
  if (!check) mkdirSync(dirname(dest), { recursive: true });
  const have = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
  if (have === want) continue;
  if (check) { console.error(`sync-channels --check: src/channels/${f} differs from chatpanel-channels`); drift += 1; continue; }
  writeFileSync(dest, want);
  console.log(`sync-channels: updated src/channels/${f}`);
}

if (check) {
  if (drift) { console.error('Run `npm run sync:channels` and commit the result.'); process.exit(1); }
  console.log('sync-channels --check: src/channels matches chatpanel-channels ✓');
}
