// Turning a CLI agent's dying breath into something a person can act on.
//
// When an agent exits non-zero we used to surface its raw stderr. For a crash that is fine;
// for the common real failure — one of the AGENT'S OWN MCP servers refusing to authenticate —
// it is not: those servers answer with an HTML error page, so the user got kilobytes of
// markup, inline CSS and an SVG logo in the chat, with the one useful sentence buried inside.
//
// The failure is also usually not ChatPanel's to fix. Saying whose it is, and naming the
// server, is the difference between "something broke" and "re-auth that server".

const NOISE = [
  /^\s*$/,
  /^\s*at\s+/,            // stack frames
  /^\s*[.#]?[\w-]+\s*\{/, // CSS rules
  /^\s*[\w-]+:\s*[^;]+;$/,// CSS declarations
  /^\s*<\//,              // closing tags
];

// Strip HTML/CSS/SVG so an error page collapses to whatever prose it contained.
export function stripMarkup(text) {
  return String(text || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

// The named causes worth translating. Each returns a sentence that says what to DO.
function knownCause(text) {
  const server = /refresh OAuth tokens for server ([\w.-]+)/i.exec(text)?.[1]
    || /server ['"]?([\w.-]+)['"]? (?:requires|failed) auth/i.exec(text)?.[1];
  if (/refresh token (?:does not exist|was rejected)|invalid_grant/i.test(text)) {
    return `${server ? `its MCP server "${server}"` : 'one of its MCP servers'} needs re-authentication — its saved OAuth token has expired or been revoked. Re-login to that server in the agent's own config; ChatPanel can't refresh it.`;
  }
  if (/invalid_token|AuthRequired|www-authenticate|\b401\b/i.test(text)) {
    return `${server ? `its MCP server "${server}"` : 'one of its MCP servers'} rejected the agent's token (401/invalid_token). Re-authenticate that server in the agent, then retry.`;
  }
  if (/HTTP 403|\b403\b/.test(text)) {
    return `${server ? `its MCP server "${server}"` : 'one of its MCP servers'} returned 403 and an error page — that server is refusing requests or is temporarily down. This is outside ChatPanel; retry when it recovers.`;
  }
  if (/ENOENT|command not found/i.test(text)) return 'the command could not be found on PATH.';
  return null;
}

/**
 * A short, actionable summary of why a CLI agent exited. Never returns markup, and never more
 * than a couple of lines — the full output stays in the bridge log for anyone debugging.
 */
export function summarizeCliError(label, code, stderr, stdout = '') {
  const raw = `${stderr || ''}\n${stdout || ''}`;
  const cause = knownCause(raw);
  if (cause) return `${label} exited ${code}: ${cause}`;

  const lines = stripMarkup(raw)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOISE.some((re) => re.test(l)));
  // Prefer the last line that reads like an error, else the last line at all.
  const errish = lines.filter((l) => /error|fail|fatal|panic|refused|denied|timeout/i.test(l));
  const pick = (errish.length ? errish : lines).pop() || 'failed';
  return `${label} exited ${code}: ${pick.length > 300 ? `${pick.slice(0, 300)}…` : pick}`;
}
