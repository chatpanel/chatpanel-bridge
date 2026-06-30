import { stripHidden } from '../sanitize.js';

function roleLabel(role) {
  return role === 'assistant' ? 'Assistant' : 'User';
}

export function buildCliPrompt(messages = [], system = '') {
  const cleanSystem = String(system || '').trim();
  const list = Array.isArray(messages) ? messages : [];
  const history = list.slice(0, -1);
  const current = list[list.length - 1];
  const parts = [];

  if (cleanSystem) parts.push(cleanSystem);

  if (history.length) {
    const transcript = history
      .map((m) => `${roleLabel(m.role)}: ${String(m.content || '').trim()}`)
      .join('\n\n');
    parts.push(`Conversation history (context only; do not answer these prior turns):\n${transcript}`);
  }

  if (current) {
    parts.push(
      `Current ${roleLabel(current.role).toLowerCase()} message (answer this message now; use the history above only as context):\n${String(current.content || '').trim()}`,
    );
  }

  // De-steganography on the final prompt before it reaches the local agent. The
  // extension already scrubs when its redaction is on, but the bridge is also a
  // public localhost endpoint other clients can call — so strip invisible/format
  // Unicode here too (hidden instructions via Tag chars, zero-width-split values,
  // injected fingerprint markers). See src/sanitize.js.
  return stripHidden(parts.join('\n\n---\n\n'));
}
