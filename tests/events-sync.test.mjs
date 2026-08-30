// Drift guard for the vendored contracts under src/events.
//
// CI does no install, so the committed copies are the source of truth there and `--check`
// would fail for the wrong reason. Run it only where the package is resolvable — locally,
// and anywhere it is installed — and skip loudly otherwise, so a real divergence is caught
// by whoever edits the package. Same shape as the extension's guard: a hand-copy that
// nothing checks is how `sanitize.js` drifted from the engine it came from.
import test from 'node:test';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('vendored contracts match chatpanel-events', () => {
  const available = [
    join(ROOT, 'node_modules', '@chatpanel', 'events'),
    join(ROOT, '..', 'chatpanel-events'),
  ].some((d) => existsSync(join(d, 'skill-manifest.js')));
  if (!available) {
    console.log('  (skipped — chatpanel-events not checked out; committed copies are source of truth here)');
    return;
  }
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'sync-events.mjs'), '--check'], { stdio: 'inherit' });
});
