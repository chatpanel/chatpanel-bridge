// GENERATED — do not edit.
// Source of truth: chatpanel-channels/src/normalize.js (npm @chatpanel/channels).
// Edit there, then run: npm run sync:channels
//
// Vendored rather than depended on: the bridge ships zero runtime dependencies so a
// curl one-liner install cannot fail on someone's registry, and so the compiled
// single-file binary has nothing to resolve. Package imports are rewritten to the
// vendored engines (src/pii, src/events) by the sync script.

// Platform message → one normalized shape the invoke/stream core understands. PURE: no
// network, no token — a Telegram update object in, a plain record out — so the whole gate
// (pairing, redaction, command routing) is unit-testable without a bot.
//
// One shape for every platform is the same discipline capability.js keeps for actors: the
// adapters are dumb transport, and everything above them speaks 'normalized message'.

export const CHANNEL_ACTOR_KIND = 'channel';

/** The actor id a paired surface invokes under: '<platform>:<chatId>'. Stable per chat. */
export function actorId(platform, chatId) {
  return `${platform}:${chatId}`;
}

// A leading "/word" is a command to US (pair/stop/new/help), not a prompt for the agent.
// Telegram appends "@BotName" to commands in groups; strip it so "/stop@mybot" === "/stop".
function parseCommand(text) {
  const m = /^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

/**
 * Normalize a Telegram getUpdates result item. Returns null for updates we don't act on
 * (edited messages, channel posts, join/leave events) so the caller skips them uniformly.
 * A photo's caption is treated as its text, matching how a person reads the message.
 */
export function normalizeTelegram(update) {
  const msg = update?.message;
  if (!msg || !msg.chat) return null;
  const text = typeof msg.text === 'string' ? msg.text
    : typeof msg.caption === 'string' ? msg.caption : '';
  // Largest photo variant only — Telegram sends a size ladder, last is the biggest.
  const photos = Array.isArray(msg.photo) && msg.photo.length
    ? [{ fileId: msg.photo[msg.photo.length - 1].file_id }]
    : [];
  const command = text.startsWith('/') ? parseCommand(text) : null;
  return {
    platform: 'telegram',
    chatId: String(msg.chat.id),
    chatType: msg.chat.type || 'private',
    messageId: String(msg.message_id),
    from: { id: String(msg.from?.id ?? msg.chat.id), name: msg.from?.first_name || msg.from?.username || '' },
    text,
    command,
    photos,
    replyToMessageId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : null,
  };
}
