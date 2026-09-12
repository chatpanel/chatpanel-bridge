// What the updater does when it CANNOT check — which is not a rare path.
//
// GitHub's unauthenticated API allows 60 requests/hour per IP and a developer machine burns
// that routinely. The old code answered a rate-limited check from a cache written hours
// earlier, and said nothing about the difference. Twice in one afternoon that produced a
// confident wrong answer: an update that installed a superseded version and called it a
// success, and a refusal — "Already on the latest version" — while a newer release sat
// published. Both are worse than an error.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';

const home = await mkdtemp(path.join(os.tmpdir(), 'cp-upd-'));
process.env.HOME = home;                       // update.js reads os.homedir() at module load
process.env.CHATPANEL_UPDATE_TIMEOUT_MS = "300"; // so a hung GitHub costs the suite 0.3s, not 5
await mkdir(path.join(home, '.chatpanel'), { recursive: true });
const cacheFile = path.join(home, '.chatpanel', 'update-check.json');
const seedCache = (obj) => writeFile(cacheFile, JSON.stringify(obj));

const { checkForUpdate, resetUpdateBackoff } = await import('../src/update.js');
const realFetch = globalThis.fetch;
const stub = (fn) => { globalThis.fetch = fn; };
const restore = () => { globalThis.fetch = realFetch; };

test('a rate-limited forced check is reported as stale, not as an answer', async () => {
  await seedCache({ checkedAt: Date.now() - 60 * 60_000, latest: '0.11.1', assetUrl: 'https://example.test/old' });
  stub(async () => ({ ok: false, status: 403, json: async () => ({}) }));
  const info = await checkForUpdate('0.11.1', { force: true });
  restore();
  assert.equal(info.stale, true, 'the caller must be able to tell a cached answer from a real one');
  assert.match(info.error, /rate limit/i, 'and be told why, in words that name the cause');
  assert.equal(info.latest, '0.11.1', 'the cached value is still returned — for display, not for acting on');
});

test('a network failure is stale too, and never silently "no update"', async () => {
  await seedCache({ checkedAt: Date.now() - 60 * 60_000, latest: '0.11.1', assetUrl: 'https://example.test/old' });
  stub(async () => { throw new Error('getaddrinfo ENOTFOUND'); });
  const info = await checkForUpdate('0.11.1', { force: true });
  restore();
  assert.equal(info.stale, true);
  assert.match(info.error, /ENOTFOUND/);
});

test('a successful check is not stale, and rewrites the cache', async () => {
  await seedCache({ checkedAt: Date.now() - 60 * 60_000, latest: '0.0.1', assetUrl: null });
  stub(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ tag_name: 'v9.9.9', assets: [] }),
  }));
  const info = await checkForUpdate('0.11.1', { force: true });
  restore();
  assert.equal(info.stale, false, 'a real answer must not be flagged stale');
  assert.equal(info.latest, '9.9.9');
  assert.equal(info.updateAvailable, true);
  assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).latest, '9.9.9', 'and it must be remembered');
});

test('selfUpdate refuses to act on a stale check', async () => {
  // selfUpdate() only runs inside the compiled binary, so the guard is asserted at the source
  // rather than executed here. It is the whole point of the `stale` flag: without this branch
  // the flag is computed and ignored.
  const src = await readFile(new URL('../src/update.js', import.meta.url), 'utf8');
  assert.match(src, /if \(info\.stale\)/, 'a stale check must stop the update');
  assert.match(src, /Refusing to act on a stale check/, 'and say so, rather than reporting a no-op as success');
});

// THE CHECK LIVES INSIDE /health. Every client heartbeat waits on it, so a GitHub that does
// not answer used to make the bridge itself look dead: the desktop's supervisor gives a
// health probe 2.5s, then restarts what it thinks has stopped.
test('a GitHub that never answers is given up on, and the health answer is stale rather than late', async () => {
  resetUpdateBackoff();
  await seedCache({ checkedAt: Date.now() - 7 * 60 * 60_000, latest: '0.11.1', assetUrl: 'https://example.test/old' });
  stub((_url, { signal } = {}) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason));
  }));
  const started = Date.now();
  const info = await checkForUpdate('0.11.1');
  restore();
  assert.ok(Date.now() - started < 2000, `answered in ${Date.now() - started}ms — the fetch must be timed out, not waited for`);
  assert.equal(info.stale, true);
  assert.match(info.error, /did not answer within/);
  assert.equal(info.latest, '0.11.1', 'the cached answer still rides along for display');
});

test('after a failure, the next health polls do not go back to the network', async () => {
  resetUpdateBackoff();
  await seedCache({ checkedAt: Date.now() - 7 * 60 * 60_000, latest: '0.11.1', assetUrl: null });
  let calls = 0;
  stub(async () => { calls += 1; throw new Error('getaddrinfo ENOTFOUND api.github.com'); });
  await checkForUpdate('0.11.1');
  const again = await checkForUpdate('0.11.1');
  const andAgain = await checkForUpdate('0.11.1');
  restore();
  assert.equal(calls, 1, 'one attempt, then the back-off answers');
  assert.equal(again.stale, true);
  assert.match(andAgain.error, /ENOTFOUND/, 'and it still says why');
});

test('a forced check ignores the back-off — the user pressed the button', async () => {
  resetUpdateBackoff();
  await seedCache({ checkedAt: Date.now() - 7 * 60 * 60_000, latest: '0.11.1', assetUrl: null });
  let calls = 0;
  stub(async () => { calls += 1; throw new Error('getaddrinfo ENOTFOUND api.github.com'); });
  await checkForUpdate('0.11.1');
  await checkForUpdate('0.11.1', { force: true });
  restore();
  resetUpdateBackoff();
  assert.equal(calls, 2);
});
