// An uninstalled CLI must STOP reporting itself available — without a bridge restart.
// The picker's green dot is a claim about right now; caching a positive result forever made
// it a claim about the past, and the turn then failed with "couldn't find it on your PATH".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../src/engines/', import.meta.url);
const engines = readdirSync(dir).filter((f) => f.endsWith('.js'));

test('no engine caches "installed" forever', () => {
  for (const f of engines) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    // The old shape: `if (!installed && …)` / `if (!cachedOk && …)` — a probe that can only
    // ever flip false→true, so an uninstall is invisible until restart.
    assert.ok(
      !/if \(!(installed|cachedOk) && Date\.now\(\) - lastProbe/.test(src),
      `${f} re-probes only while NOT found, so an uninstalled CLI stays "available"`,
    );
  }
});

test('engines that probe do so on an interval that covers both directions', () => {
  const probing = engines.filter((f) => /lastProbe/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.ok(probing.length >= 3, `found ${probing.length} probing engines`);
  for (const f of probing) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.match(
      src, /Date\.now\(\) - lastProbe > \((installed|cachedOk) \? 30_000 : 4000\)/,
      `${f} should re-check a found CLI slowly and a missing one quickly`,
    );
  }
});
