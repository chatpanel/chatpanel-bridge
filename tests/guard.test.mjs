// Who may reach which route, asserted against a REAL server rather than described in a
// comment. The guard is the thing standing between a web page and the user's machine, and
// it was recently changed: /skills is origin-checked but not privileged, /debug is both.
//
// The reasoning for that split lives above PRIVILEGED_GET in server.js. The reason it is
// tested here is that the split is only safe while the origin allowlist still refuses a
// page — and nothing else in the suite would notice if that stopped being true.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import net from 'node:net';

/** A GET with a Host header of our choosing — fetch() refuses to send one. */
function rawGet(path, host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (c) => { buf += c; });
    sock.on('end', () => resolve(buf.split('\r\n')[0]));
    sock.on('error', reject);
  });
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4471;
const BASE = `http://127.0.0.1:${PORT}`;
const EXT = 'chrome-extension://mhgkkilhddnoebfbbmgocknfgfpkljih';

let proc;

before(async () => {
  proc = spawn(process.execPath, [join(ROOT, 'src', 'server.js')], {
    env: { ...process.env, CHATPANEL_BRIDGE_PORT: String(PORT), CHATPANEL_SKILL_DIRS: '' },
    stdio: 'ignore',
  });
  // Poll rather than sleep: a fixed wait is either flaky or slow, and /health is the
  // readiness signal the extension itself uses.
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`bridge did not start on ${PORT}`);
});

after(() => proc?.kill());

const status = (path, origin) => fetch(`${BASE}${path}`, {
  headers: origin ? { Origin: origin } : {},
}).then((r) => r.status);

test('a web page cannot read the skill store', async () => {
  // The one that matters. A page always sends Origin, so this is the check doing the work
  // now that /skills is not privileged.
  assert.equal(await status('/skills', 'https://evil.example'), 403);
  assert.equal(await status('/skills/anything', 'https://evil.example'), 403);
  assert.equal(await status('/skills/a/file/references/x.md', 'http://attacker.test'), 403);
});

test('the extension can read the skill store', async () => {
  // Chrome omits Origin on a simple GET from an extension page, so BOTH of these are the
  // extension in practice — which is exactly why requiring the header broke it.
  assert.equal(await status('/skills', EXT), 200);
  assert.equal(await status('/skills'), 200);
  assert.equal(await status('/skills', 'moz-extension://abc'), 200, 'Firefox too');
});

test('the extension can read the channel status', async () => {
  // 0.11.0 shipped /channels as a privileged GET and the Telegram card could only ever say
  // the bridge refused it. The panel holds `<all_urls>`, so its fetches bypass CORS and no
  // preflight fires; `Origin` rides only on non-GET methods. The no-Origin case below IS the
  // extension — it is not a hypothetical local script.
  assert.equal(await status('/channels'), 200, 'the settings page sends no Origin on a GET');
  assert.equal(await status('/channels', EXT), 200);
  assert.equal(await status('/channels', 'moz-extension://abc'), 200, 'Firefox too');
});

test('a web page cannot read which phones are paired', async () => {
  // What actually protects the pairing list, now that the GET is not privileged: a page
  // always sends Origin, and the allowlist refuses it.
  assert.equal(await status('/channels', 'https://evil.example'), 403);
  assert.equal(await status('/channels', 'http://attacker.test'), 403);
});

test('configuring a channel stays privileged — those are POSTs, which do carry Origin', async () => {
  // The asymmetry is the point: writes keep the guard because the browser gives them an
  // Origin to be guarded by. Connecting a bot or enrolling a phone is a way into this machine.
  for (const path of ['/channels/connect', '/channels/pair', '/channels/unpair', '/channels/settings', '/channels/disconnect']) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 403, `${path} must refuse a no-Origin caller`);
  }
});

test('/debug stays privileged — it exposes what a local process cannot otherwise see', async () => {
  assert.equal(await status('/debug'), 403, 'a no-Origin caller must not get configuration');
  assert.equal(await status('/debug', 'https://evil.example'), 403);
  assert.equal(await status('/debug', EXT), 200);
});

test('the DNS-rebinding guard still fires before anything else', async () => {
  // A remote SSRF into 127.0.0.1 arrives with a non-loopback Host. This is what makes
  // "a no-Origin caller is a local process" true in the first place — so it is asserted,
  // not assumed. A raw socket is required: fetch() silently DROPS a Host header (it is a
  // forbidden header name), so the obvious version of this test passes against a server
  // with no guard at all.
  const line = await rawGet('/skills', 'evil.example');
  assert.match(line, /^HTTP\/1\.1 403/, `expected a rebinding refusal, got: ${line}`);
  // Control: the same request with a loopback Host is served, so the 403 above is the
  // Host check firing rather than the request being malformed.
  assert.match(await rawGet('/skills', `127.0.0.1:${PORT}`), /^HTTP\/1\.1 200/);
});

test('an unknown skill is a 404, and it says nothing about the filesystem', async () => {
  const res = await fetch(`${BASE}/skills/definitely-not-a-real-skill`, { headers: { Origin: EXT } });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'unknown skill');
  assert.ok(!JSON.stringify(body).includes('/'), 'an error must not leak a path');
});

test('health advertises the skills capability so a client need not probe for it', async () => {
  const health = await (await fetch(`${BASE}/health`)).json();
  assert.ok(health.skills, '/health should carry the additive skills summary');
  assert.equal(typeof health.skills.count, 'number');
});
