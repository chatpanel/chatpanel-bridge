// The bridge as the channel HOST: the routes a settings screen drives, and the guard on them.
//
// A channel is a way into this machine from the internet, so the interesting assertions are
// about who may configure one and what a status reply is allowed to contain — not about
// Telegram, which never appears here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const server = readFileSync(join(ROOT, 'src', 'server.js'), 'utf8');

test('every channel route that changes anything is privileged', () => {
  // The failure this prevents: a route added next to nine guarded neighbours, reachable by any
  // local process — which for /channels/connect would mean pointing the user's bot at someone
  // else's, and for /channels/pair would mean minting an enrollment code for a stranger.
  for (const p of ['connect', 'pair', 'unpair', 'settings', 'disconnect']) {
    assert.match(server, new RegExp(`'/channels/${p}',`), `/channels/${p} must be in PRIVILEGED_POST`);
  }
  // ...and the READ deliberately is not. This assertion used to require the opposite, which
  // is how 0.11.0 shipped a status route the extension could never call: the panel holds
  // `<all_urls>`, so its fetches bypass CORS and `Origin` rides only on non-GET methods, and a
  // privileged GET can therefore only ever answer "forbidden". The pairing list is protected
  // by the origin allowlist refusing web pages (asserted in guard.test.mjs), and a local
  // process can read ~/.chatpanel/channels/ off the disk regardless.
  assert.match(server, /PRIVILEGED_GET = new Set\(\['\/debug'\]\)/,
    'GET /channels must stay unprivileged — a privileged GET is unreachable from the panel');
});

test('the channel service is loaded lazily and pointed at this bridge', () => {
  assert.match(server, /await import\('\.\/channels\/service\.js'\)/,
    'the redaction engine must not load on a boot where no channel is configured');
  assert.match(server, /baseUrl: `http:\/\/127\.0\.0\.1:\$\{PORT\}`, token: AUTH_TOKEN/,
    'the adapter talks to THIS bridge with the token it already read — no second address to misconfigure');
  assert.match(server, /startIfConfigured\(\)/, 'a connected channel must come back after a reboot on its own');
});

test('status can never carry the bot token', async () => {
  // Asserted against the vendored copy the bridge actually loads, not the package.
  const { createChannelService } = await import('../src/channels/service.js');
  const svc = createChannelService({
    home: join(ROOT, 'tests', '.no-such-home'),
    dataDir: join(ROOT, 'tests', '.no-such-home', 'channels'),
    bridge: { baseUrl: 'http://127.0.0.1:1', token: 'x' },
    logger: { log() {}, warn() {}, error() {} },
  });
  const st = await svc.status();
  assert.equal(st.configured, false);
  assert.equal(st.running, false);
  assert.ok(!('token' in st) && !('botToken' in st));
});

test('the vendored copies match their packages', () => {
  // The bridge has no node_modules in CI, so this runs only where the sources are checked out —
  // i.e. wherever someone is actually in a position to have edited them.
  const available = (rel, probe) => existsSync(join(ROOT, '..', rel, probe));
  const checks = [
    ['sync-pii.mjs', available('chatpanel-pii', 'pii-redact.js')],
    ['sync-events.mjs', available('chatpanel-events', 'event.js')],
    ['sync-channels.mjs', available('chatpanel-channels', 'src/service.js')],
  ];
  for (const [script, ok] of checks) {
    if (!ok) { console.log(`  (skipped ${script} — package not checked out)`); continue; }
    execFileSync(process.execPath, [join(ROOT, 'scripts', script), '--check'], { stdio: 'pipe' });
  }
});
