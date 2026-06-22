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

  return parts.join('\n\n---\n\n');
}
