// U4 — the bridge installer offers the gateway in the same flow (one download story).
// The bridge is always installed (common case); the gateway is opt-in and heavier.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const sh = readFileSync(new URL('../scripts/install.sh', import.meta.url), 'utf8');
const ps1 = readFileSync(new URL('../scripts/install.ps1', import.meta.url), 'utf8');

test('the bridge is installed unconditionally; the gateway is opt-in', () => {
  // The bridge install must not depend on the flag — that is the common case.
  assert.match(sh, /"\$bin" --install/, 'the bridge always installs');
  assert.match(sh, /WITH_GATEWAY=0/, 'the gateway defaults OFF');
  assert.match(sh, /--gateway\|--with-gateway\) WITH_GATEWAY=1/, 'a flag opts into the gateway');
});

test('--gateway chains the gateway installer, and its failure does not fail the bridge', () => {
  assert.match(sh, /if \[ "\$WITH_GATEWAY" = "1" \]/, 'the gateway install is guarded by the flag');
  assert.match(sh, /dl\.chatpanel\.net\/gateway\/install\.sh \| bash/, 'and uses the same dl host — one download story');
  // It is in an `if`, so `set -e` will not abort the (already-succeeded) bridge install.
  assert.match(sh, /Gateway install didn't complete — the bridge is unaffected/, 'a gateway failure is non-fatal and says so');
});

test('without the flag, the gateway is offered as an optional upgrade — not pushed', () => {
  assert.match(sh, /Optional upgrade/, 'the default path names the gateway as optional');
  assert.match(sh, /re-run this with --gateway/, 'and shows how to add it');
  assert.doesNotMatch(sh, /Gateway is required|must install the gateway/i, 'never presented as required');
});

test('Windows parity: the note points at the gateway installer', () => {
  assert.match(ps1, /Optional upgrade/, 'the ps1 offers the gateway too');
  assert.match(ps1, /gateway\/install\.ps1 \| iex/, 'via the same dl host');
});

test('the script is valid bash structure (balanced if/fi)', () => {
  const ifs = (sh.match(/\bif \[/g) || []).length;
  const fis = (sh.match(/^fi$/gm) || []).length + (sh.match(/; fi\b/g) || []).length;
  assert.ok(fis >= 1, 'has closing fi');
  assert.ok(ifs >= 1, 'has if');
});
