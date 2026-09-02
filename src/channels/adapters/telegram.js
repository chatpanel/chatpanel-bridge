// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/adapters/telegram.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// Telegram adapter — the LOCAL shape (§3 of feature-f7). getUpdates long-poll is
// OUTBOUND-ONLY, so this mirrors Claude Code Remote Control's key property: the machine never
// opens an inbound port, works behind NAT, needs no tunnel. The adapter is dumb transport;
// normalize → gate → redact → invoke → stream → restore is the shared core it drives.

import { normalizeTelegram, actorId } from '../normalize.js';
import {
  buildInvocation, redactInbound, outboundText, appendTurn,
  appendInvoked, appendRedacted, appendEgress,
} from '../invoke.js';
import * as bridge from '../bridge.js';
import { splitForTelegram, createGate } from '../stream.js';
import { createVault } from '../../pii/index.js';

const TG_HOST = 'api.telegram.org';

const HELP = [
  'ChatPanel — drive your local agent from here.',
  '',
  'Send a message and I run it on your machine.',
  '/pair <code> — enroll this chat (ChatPanel → Settings → Channels)',
  '/new         — start fresh (forget this conversation + new privacy vault)',
  '/stop        — stop the current run',
  '/help        — this message',
].join('\n');

/**
 * Start the long-poll loop. Returns the loop promise; abort `signal` to stop it. Everything
 * it needs is injected — a bot token, the bridge address+token, a pairing store, an event sink
 * — so nothing here reads a secret or reaches for global state.
 */
export function startTelegram({
  botToken,
  baseUrl,
  token,                       // bridge token
  pairing,                     // createPairingStore(...)
  savePairing = async () => {},
  appender,                    // createEventLog(...) or nullEventLog()
  agent = 'claude',
  // Which transport answers, and with what. `bridge` runs a CLI agent on this machine;
  // `gateway` reaches any destination the user configured there — an API provider or, via the
  // gateway's own bridge backend, the same CLI agents. The adapter must not be able to tell
  // which it has: both expose chat()/cancel() and fold into one reply state.
  transport = bridge,
  model = '',
  provider = '',
  system = '',
  redact = { tier: 'basic' },
  privacy = 'standard',
  logger = console,
  signal,                      // AbortSignal to stop the whole loop
}) {
  const api = `https://${TG_HOST}/bot${botToken}`;
  const fileApi = `https://${TG_HOST}/file/bot${botToken}`;
  // Per-chat session: a persistent vault (stable placeholders across turns), the live run id
  // (/stop), and the redacted conversation history (multi-turn context).
  const chats = new Map(); // chatId -> { vault, runId, history }
  const freshChat = () => ({ vault: createVault(), runId: null, history: [] });
  const chatState = (id) => {
    if (!chats.has(id)) chats.set(id, freshChat());
    return chats.get(id);
  };

  async function tg(method, body) {
    const res = await fetch(`${api}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    return res.json();
  }
  const send = (chatId, text) => tg('sendMessage', { chat_id: chatId, text });
  const edit = (chatId, messageId, text) => tg('editMessageText', { chat_id: chatId, message_id: messageId, text });

  // Resolve Telegram photos to the { dataUrl } shape the bridge's engines expect (Claude Code
  // writes them to temp files and reads them as vision). A failed fetch drops that one image
  // rather than failing the whole turn.
  async function toBridgeImages(photos) {
    const out = [];
    for (const p of photos || []) {
      try {
        const info = await tg('getFile', { file_id: p.fileId });
        const fp = info?.result?.file_path;
        if (!fp) continue;
        const bin = await fetch(`${fileApi}/${fp}`, { signal });
        const buf = Buffer.from(await bin.arrayBuffer());
        const mime = /\.png$/i.test(fp) ? 'image/png' : /\.webp$/i.test(fp) ? 'image/webp' : 'image/jpeg';
        out.push({ dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
      } catch (e) { logger.warn?.(`[telegram] image fetch failed: ${e?.message || e}`); }
    }
    return out;
  }

  async function handleCommand(norm) {
    const id = actorId('telegram', norm.chatId);
    const { name, args } = norm.command;
    // `/start <code>` is what a t.me/<bot>?start=<code> link SENDS. Telegram turns the link
    // into that first message, so tapping "Pair this phone" in ChatPanel enrolls in one tap —
    // no six digits thumbed in from another screen. Bare /start is still the greeting.
    const pairCode = name === 'pair' || (name === 'start' && args) ? args : '';
    if (pairCode) {
      const r = pairing.redeem(id, pairCode, { label: norm.from?.name || '' });
      await savePairing();
      return void send(norm.chatId, r.ok
        ? `✅ paired (reach: ${r.reach}). Send me anything — I'll run it on your machine.`
        : `⛔ ${r.reason}`);
    }
    if (name === 'help' || name === 'start') return void send(norm.chatId, HELP);
    if (name === 'pair') return void send(norm.chatId, 'send /pair <code> — get the code in ChatPanel → Settings → Channels');
    if (name === 'new') {
      chats.set(norm.chatId, freshChat());
      return void send(norm.chatId, '🧹 fresh conversation.');
    }
    if (name === 'stop') {
      const st = chatState(norm.chatId);
      const ok = await transport.cancel(st.runId, { baseUrl, token });
      st.runId = null;
      return void send(norm.chatId, ok ? '⏹ stopped.' : 'nothing running.');
    }
    return void send(norm.chatId, `unknown command /${name} — try /help`);
  }

  async function handleMessage(norm) {
    const id = actorId('telegram', norm.chatId);
    // AUTHENTICATION gate: an unpaired sender cannot drive anything. This proves WHO, not WHAT
    // — tool scoping (reach → per-actor allowlist) is the next layer and lives above the bridge.
    const reach = pairing.reachOf(id);
    if (!reach) {
      return void send(norm.chatId, '🔒 not paired. Get a code in the ChatPanel extension, then send: /pair <code>');
    }
    if (!norm.text && !norm.photos.length) return;
    const st = chatState(norm.chatId);

    // Contract + audit BEFORE anything leaves for the agent.
    let invocation;
    try { invocation = buildInvocation(norm); }
    catch (e) { return void send(norm.chatId, `⚠️ ${e.message}`); }

    const { redacted, counts } = redactInbound(norm.text, st.vault, redact);
    await appendInvoked(appender, invocation);
    await appendRedacted(appender, counts);

    const images = await toBridgeImages(norm.photos);
    const placeholder = await tg('sendMessage', { chat_id: norm.chatId, text: '…' });
    const replyId = placeholder?.result?.message_id;
    const gate = createGate(1200); // ~1 edit/sec, Telegram's ceiling for a chat
    let shown = '';

    // Replay prior turns as context; the new (redacted) message is the live one. buildCliPrompt
    // on the bridge renders all-but-last as history and the last as "answer this now".
    const messages = [...st.history, { role: 'user', content: redacted }];

    try {
      const finalState = await transport.chat(
        { agent, model, provider, system, messages, images, options: { reach } },
        {
          baseUrl, token, signal,
          onEvent: (ev, state) => {
            if (state.runId) st.runId = state.runId;
            // Driven by the folded STATE, not by an event's `type`: the bridge emits
            // {type:'delta'} and the gateway emits OpenAI chunks, and this has to work on both.
            // The `first !== shown` guard below makes a no-text event a no-op anyway.
            if (replyId && (state.done || gate.ready())) {
              const text = outboundText(state.text, st.vault, { privacy });
              const first = splitForTelegram(text || '…')[0];
              if (first && first !== shown) { shown = first; edit(norm.chatId, replyId, first).catch(() => {}); }
            }
          },
        },
      );
      st.runId = null;

      const restored = outboundText(finalState.text, st.vault, { privacy });
      const chunks = splitForTelegram(finalState.error ? `⚠️ ${finalState.error}` : (restored || '(no output)'));
      if (replyId) await edit(norm.chatId, replyId, chunks[0]);
      else await send(norm.chatId, chunks[0]);
      for (const extra of chunks.slice(1)) await send(norm.chatId, extra);

      // Remember the exchange for follow-ups — the REDACTED forms, so what we replay next turn
      // never carries a real value and stays consistent with the vault. A failed turn (error /
      // no text) records nothing, so history never implies an answer that didn't happen.
      if (!finalState.error && finalState.text) st.history = appendTurn(st.history, redacted, finalState.text);

      // Egress to Telegram, recorded: 'standard' restores real values (a third party sees
      // them → redacted:false); 'strict' keeps placeholders (redacted:true). controlled:false
      // either way — Telegram is not ours.
      await appendEgress(appender, { host: TG_HOST, redacted: privacy === 'strict', controlled: false });
    } catch (e) {
      st.runId = null;
      const msg = `⚠️ ${e?.message || e}`;
      if (replyId) await edit(norm.chatId, replyId, msg).catch(() => {});
      else await send(norm.chatId, msg).catch(() => {});
    }
  }

  // A sleep that gives up when the loop is asked to stop, so Ctrl-C is immediate rather than
  // "immediate in up to five seconds".
  const nap = (ms) => new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let t;
    const done = () => { clearTimeout(t); signal?.removeEventListener?.('abort', done); resolve(); };
    t = setTimeout(done, ms);
    signal?.addEventListener?.('abort', done, { once: true });
  });

  async function loop() {
    let offset = 0;
    logger.log?.('[telegram] long-poll started (outbound-only; no inbound port).');
    while (!signal?.aborted) {
      let updates;
      try {
        const res = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
        // Telegram REFUSES with a normal JSON body, not an HTTP error this code would throw
        // on: a bad token answers {ok:false, 401} INSTANTLY, so `res.result || []` turned a
        // wrong token into a silent hot loop — no message, no long-poll delay, and an API
        // hammered hard enough to get rate-limited. The two refusals that actually happen
        // during setup are named, because "nothing arrives" is the same symptom as "it works
        // and nobody has texted you".
        if (res && res.ok === false) {
          const code = res.error_code;
          const hint = code === 401 ? ' — check the bot token (@BotFather → /mybots → API token)'
            : code === 409 ? ' — another chatpanel-channels (or another poller) is already reading this bot'
              : '';
          logger.error?.(`[telegram] getUpdates refused: ${res.description || `error_code ${code}`}${hint}`);
          await nap(5000);
          continue;
        }
        updates = res?.result || [];
      } catch (e) {
        if (signal?.aborted) break;
        logger.warn?.(`[telegram] getUpdates failed: ${e?.message || e}; retrying in 2s`);
        await nap(2000);
        continue;
      }
      for (const u of updates) {
        offset = u.update_id + 1;
        const norm = normalizeTelegram(u);
        if (!norm) continue;
        // Fire-and-forget per message so one slow turn doesn't stall the poll; errors are
        // caught so a single bad message never kills the loop.
        const run = norm.command ? handleCommand(norm) : handleMessage(norm);
        Promise.resolve(run).catch((e) => logger.error?.(`[telegram] handler error: ${e?.message || e}`));
      }
    }
    logger.log?.('[telegram] stopped.');
  }

  return loop();
}
