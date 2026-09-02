// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/service.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// The channel SERVICE — connect · pair · status · disconnect, as one contract a UI can drive.
//
// The adapter is a loop. A *service* is what a person can actually operate: is it connected,
// to which bot, who is paired, give me a code, stop it. That contract lives here rather than
// inside whichever process happens to host the loop, because there is more than one host — the
// bridge (always on, and what a non-technical user already has), the CLI (headless boxes), and
// a desktop app later. Three hosts implementing "connect a bot" is three different security
// postures for the same secret.
//
// It owns exactly the state a channel has:
//   • the bot token — a 0600 file, read at start, NEVER returned by status();
//   • the pairing store — who may drive an agent, and their reach ceiling;
//   • the per-channel settings — which agent answers, and the privacy mode.
//
// It owns none of the transport around it: no HTTP, no auth, no UI. The host does that, which
// is why this module needs no server and is testable with a stub fetch.

import path from 'node:path';
import { readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { createPairingStore } from './pairing.js';
import * as bridgeTransport from './bridge.js';
import * as gateway from './gateway.js';

// The gateway's fixed local port (see chatpanel-gateway: 4319 bridge / 4320 gateway).
const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:4320';
import { createEventLog } from './eventlog.js';
import { startTelegram } from './adapters/telegram.js';

const TELEGRAM_API = 'https://api.telegram.org';
// `agent` routes through the bridge (a CLI on this machine). `model` routes through the
// gateway, which reaches every destination the user configured there — API providers AND, via
// its own bridge backend, the same agents. They are mutually exclusive: update() clears one
// when the other is set, because "which thing answers" is one choice, not two.
export const DEFAULT_SETTINGS = Object.freeze({
  agent: 'claude', model: '', provider: '', gatewayUrl: DEFAULT_GATEWAY_URL,
  privacy: 'standard', tier: 'basic',
});

// Restart backoff. A long-poll that dies (network drop, laptop asleep, Telegram hiccup) must
// come back on its own — a channel nobody is watching is exactly the one that must self-heal —
// but a token that has been REVOKED would otherwise spin forever, so the wait grows.
const RETRY_MS = [2_000, 5_000, 15_000, 60_000];

const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });

/**
 * Ask Telegram who this token belongs to. This is the ONLY validation that matters at connect
 * time: a typo'd token must fail in the settings screen, with a reason, rather than becoming a
 * silent poll loop nobody sees the logs of.
 */
export async function verifyBot(botToken, { fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(`${TELEGRAM_API}/bot${String(botToken || '').trim()}/getMe`, { signal });
  const body = await res.json().catch(() => null);
  if (!body?.ok) {
    const why = body?.description || `HTTP ${res.status}`;
    throw new Error(/unauthorized/i.test(why) ? 'Telegram rejected that token — copy it again from @BotFather' : why);
  }
  return { id: body.result.id, username: body.result.username, name: body.result.first_name || '' };
}

/** The t.me link that pairs in one tap: Telegram turns it into "/start <code>" in the chat. */
export const pairLink = (username, code) => `https://t.me/${username}?start=${code}`;

export function createChannelService({
  home,                          // ~/.chatpanel — where the token file lives
  dataDir,                       // ~/.chatpanel/channels — pairing, config, event log
  bridge,                        // { baseUrl, token } — how the adapter reaches the agent
  logger = console,
  fetchImpl = undefined,         // injected in tests
  now = () => Date.now(),
  // The adapter is injectable for the same reason fetchImpl is: the thing worth asserting
  // about the loop is WHAT it is handed, and a real Telegram long-poll cannot be asked.
  startAdapter = startTelegram,
} = {}) {
  const tokenFile = path.join(home, 'telegram-token');
  const configFile = path.join(dataDir, 'config.json');
  const pairingFile = path.join(dataDir, 'pairing.json');

  let pairing = null; // created by load(), then kept — see the note there
  let settings = { ...DEFAULT_SETTINGS };
  let appender = null;
  let bot = null;              // { id, username, name } once verified
  let controller = null;       // aborts the running loop
  let running = false;
  let lastError = '';
  let attempt = 0;
  let stopped = true;          // deliberate stop — suppresses the restart

  const savePairing = () => writeJson(pairingFile, pairing ? pairing.toJSON() : {});
  const saveSettings = () => writeJson(configFile, settings);

  async function readToken() {
    try {
      const t = (await readFile(tokenFile, 'utf8')).trim();
      if (!t) return '';
      try {
        const { mode } = await stat(tokenFile);
        if (mode & 0o077) logger.warn?.(`[channels] ${tokenFile} is group/world-readable — chmod 600 it (it holds your bot token).`);
      } catch { /* best effort */ }
      return t;
    } catch { return ''; }
  }

  async function load() {
    await mkdir(dataDir, { recursive: true });
    // Built ONCE and never replaced. spawnLoop() hands this exact object to the adapter, which
    // holds it for the life of a polling loop — so rebuilding it here (as every service call
    // used to) broke pairing in both directions at once: `pair()` minted the code into a fresh
    // store the adapter could not see, so every redeem answered "unknown or expired code" no
    // matter how many codes you generated; and `savePairing()` serialises whichever store this
    // variable currently points at, so a redeem that DID land would have been persisted from
    // the wrong object. Two aliases of one thing is the bug — there is only ever one store.
    if (!pairing) pairing = createPairingStore(await readJson(pairingFile, {}), { now });
    settings = { ...DEFAULT_SETTINGS, ...(await readJson(configFile, {})) };
    if (!appender) appender = await createEventLog({ file: path.join(dataDir, 'events.jsonl'), host: 'channel' });
  }

  // One supervised run of the loop. Resolves when the loop ends; schedules its own restart
  // unless the stop was deliberate.
  function spawnLoop(botToken) {
    controller = new AbortController();
    running = true;
    // Resolved PER MESSAGE, not once at start. The loop owns every conversation's history and
    // privacy vault, so restarting it to pick up a settings change threw away the thing the
    // user came for. Now nothing needs a restart: the next message simply reads this.
    const route = () => {
      const viaGateway = !!settings.model;
      return {
        transport: viaGateway ? gateway : bridgeTransport,
        agent: viaGateway ? '' : settings.agent,
        model: viaGateway ? settings.model : '',
        provider: viaGateway ? (settings.provider || '') : '',
        baseUrl: viaGateway ? (settings.gatewayUrl || DEFAULT_GATEWAY_URL) : bridge.baseUrl,
        system: settings.system || '',
        privacy: settings.privacy,
      };
    };
    const done = startAdapter({
      botToken,
      route,
      transport: route().transport,
      model: route().model,
      provider: route().provider,
      baseUrl: route().baseUrl,
      token: bridge.token,
      pairing,
      savePairing,
      appender,
      agent: settings.agent,
      system: settings.system || '',
      redact: { tier: settings.tier },
      privacy: settings.privacy,
      logger,
      signal: controller.signal,
    });
    Promise.resolve(done)
      .catch((e) => { lastError = e?.message || String(e); logger.warn?.(`[channels] telegram loop failed: ${lastError}`); })
      .finally(() => {
        running = false;
        if (stopped) return;
        const wait = RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)];
        logger.warn?.(`[channels] telegram stopped unexpectedly — retrying in ${Math.round(wait / 1000)}s`);
        setTimeout(() => { if (!stopped) spawnLoop(botToken); }, wait).unref?.();
      });
  }

  async function start() {
    if (running) return { ok: true, already: true };
    await load();
    const botToken = await readToken();
    if (!botToken) return { ok: false, error: 'no bot token configured' };
    if (settings.enabled === false) return { ok: false, error: 'channel is turned off' };
    try {
      bot = await verifyBot(botToken, { fetchImpl });
    } catch (e) {
      // A revoked or mistyped token must SAY so and stay stopped — a poll loop against a dead
      // token is the failure that looks like "nobody has messaged me yet".
      lastError = e?.message || String(e);
      return { ok: false, error: lastError };
    }
    lastError = '';
    attempt = 0;
    stopped = false;
    spawnLoop(botToken);
    return { ok: true, bot };
  }

  return {
    /** Start on host boot, but only if the user already connected one. Never throws. */
    async startIfConfigured() {
      await load();
      if (!(await readToken()) || settings.enabled === false) return { ok: false, skipped: true };
      return start().catch((e) => ({ ok: false, error: e?.message || String(e) }));
    },

    start,

    /**
     * Connect a bot: verify the token FIRST, then persist it 0600 and start. Verifying before
     * writing means a typo never leaves a dead secret on disk.
     */
    async connect({ token: botToken, agent, privacy, tier } = {}) {
      await load();
      const verified = await verifyBot(botToken, { fetchImpl }); // throws with a readable reason
      await writeFile(tokenFile, String(botToken).trim(), { mode: 0o600 });
      settings = {
        ...settings,
        ...(agent ? { agent } : {}),
        ...(privacy ? { privacy } : {}),
        ...(tier ? { tier } : {}),
        enabled: true,
      };
      await saveSettings();
      await this.stop();
      const r = await start();
      if (!r.ok) throw new Error(r.error);
      return { bot: verified, settings: { ...settings } };
    },

    /**
     * Mint a one-time enrollment code and the link that redeems it in one tap. The code is the
     * fallback for someone reading it off a screen; the link is the path most people take.
     */
    async pair({ ttlMs = 10 * 60_000 } = {}) {
      await load();
      if (!bot) throw new Error('connect a bot first');
      const code = pairing.requestCode({ ttlMs });
      await savePairing();
      return { code, link: pairLink(bot.username, code), expiresAt: now() + ttlMs, bot: { ...bot } };
    },

    /**
     * Pre-pair without a code — an operator allow-list for scripted setups. Explicit by
     * design: there is no path here that enrolls a chat because it messaged you.
     */
    async allow(actorId, { reach = 'trusted' } = {}) {
      await load();
      pairing.allow(actorId, { reach });
      await savePairing();
      return { actorId, reach };
    },

    /** Revoke one phone. Takes effect on its NEXT message — nothing is cached per chat. */
    async unpair(actorId) {
      await load();
      const removed = pairing.revoke(actorId);
      await savePairing();
      return { removed };
    },

    async update(patch = {}) {
      await load();
      const next = { ...settings };
          for (const k of ['agent', 'model', 'provider', 'gatewayUrl', 'privacy', 'tier', 'system']) {
        if (patch[k] != null) next[k] = patch[k];
      }
      // Picking one target unpicks the other. Without this a stale `model` would silently win
      // over the agent the user just chose, and the screen would disagree with the machine.
      if (patch.agent != null && patch.model == null) { next.model = ''; next.provider = ''; }
      if (patch.model) next.agent = '';
      settings = next;
      await saveSettings();
      // NO RESTART. The loop reads settings per message through `route`, and restarting it
      // would discard every conversation's history and vault — which is exactly what made
      // changing the model answer the next question with "this looks like a fresh session".
      // The only change that still needs a restart is a new bot token, and connect() does that.
      return { settings: { ...settings } };
    },

    /** Stop the loop. `forget` also deletes the token and every pairing — a real disconnect. */
    async stop({ forget = false } = {}) {
      stopped = true;
      controller?.abort();
      controller = null;
      running = false;
      if (forget) {
        await load();
        settings = { ...settings, enabled: false };
        await saveSettings();
        await rm(tokenFile, { force: true });
        for (const p of pairing.list()) pairing.revoke(p.actorId);
        await savePairing();
        bot = null;
      }
      return { ok: true };
    },

    /**
     * Everything a settings screen needs and nothing it must not have: no bot token, ever.
     * `configured` says a token exists; `running` says the loop is actually polling.
     */
    async status() {
      await load();
      const configured = !!(await readToken());
      return {
        channel: 'telegram',
        configured,
        enabled: settings.enabled !== false,
        running,
        bot: bot ? { ...bot } : null,
        error: lastError,
        paired: pairing.list(),
        settings: {
          agent: settings.agent,
          model: settings.model || '',
          provider: settings.provider || '',
          gatewayUrl: settings.gatewayUrl || DEFAULT_GATEWAY_URL,
          privacy: settings.privacy,
          tier: settings.tier,
        },
        // Which transport a message will actually take, so a screen can say so rather than
        // inferring it from two fields and getting it wrong.
        via: settings.model ? 'gateway' : 'bridge',
      };
    },
  };
}
