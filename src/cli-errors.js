// Turning a CLI agent's dying breath into something a person can act on.
//
// When an agent exits non-zero we used to surface its raw stderr. For a crash that is fine;
// for the common real failure — one of the AGENT'S OWN MCP servers refusing to authenticate —
// it is not: those servers answer with an HTML error page, so the user got kilobytes of
// markup, inline CSS and an SVG logo in the chat, with the one useful sentence buried inside.
//
// The failure is also usually not ChatPanel's to fix. Saying whose it is, and naming the
// server, is the difference between "something broke" and "re-auth that server".
//
// `mcpFailure` is the machine-readable half of the same knowledge: mcp-quarantine.js reads
// it to DROP the offending server and run again, so the common cases never reach a human at
// all. One set of patterns serves both — a second copy would drift.

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

// Which server the output blames, if it names one. Codex and Claude Code phrase this several
// ways, so try each; a name we cannot read means there is nothing to disable, which is why
// every caller must tolerate `null`.
const SERVER_PATTERNS = [
  /(?:refresh OAuth tokens|refresh tools) for (?:MCP )?server ['"`]?([\w.-]+)['"`]?/i,
  /MCP server ['"`]([\w.-]+)['"`]/i,
  /server ['"]?([\w.-]+)['"]? (?:requires|failed) auth/i,
];
export function mcpServerName(text) {
  for (const re of SERVER_PATTERNS) {
    const name = re.exec(String(text || ''))?.[1];
    if (name) return name;
  }
  return null;
}

// The named MCP causes worth translating. `say` is the sentence for a human; `short` is the
// clause used when we skip the server and carry on. Order matters — specific before generic.
const MCP_CAUSES = [
  {
    kind: 'expired',
    test: /refresh token (?:does not exist|was rejected)|invalid_grant/i,
    short: 'its saved login has expired',
    say: (who) => `${who} needs re-authentication — its saved OAuth token has expired or been revoked. Re-login to that server in the agent's own config; ChatPanel can't refresh it.`,
  },
  {
    kind: 'unauthorized',
    test: /invalid_token|AuthRequired|www-authenticate|\b401\b/i,
    short: 'it rejected the agent\'s token',
    say: (who) => `${who} rejected the agent's token (401/invalid_token). Re-authenticate that server in the agent, then retry.`,
  },
  {
    kind: 'refused',
    test: /HTTP 403|\b403\b/,
    short: 'it is refusing requests',
    say: (who) => `${who} returned 403 and an error page — that server is refusing requests or is temporarily down. This is outside ChatPanel; retry when it recovers.`,
  },
  {
    // The off-network case: a VPN-only server seen from a cafe. Only counted when the text
    // is talking about MCP at all, so an ordinary provider timeout is not misread as this.
    kind: 'unreachable',
    requiresMcpContext: true,
    test: /handshaking with MCP server failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|dns error|connection (?:refused|reset)|failed to start and is unavailable|network is unreachable/i,
    short: 'it could not be reached',
    say: (who) => `${who} could not be reached — it is offline, or needs a network (VPN) this machine is not on. ChatPanel can't reach it either; retry when it is available.`,
  },
];

/**
 * Classify an MCP-server failure in an agent's output.
 * @returns {{server: string|null, kind: string, short: string, say: string}|null}
 */
export function mcpFailure(text) {
  const raw = String(text || '');
  const server = mcpServerName(raw);
  const hasMcpContext = /\bmcp\b/i.test(raw) || !!server;
  for (const cause of MCP_CAUSES) {
    if (cause.requiresMcpContext && !hasMcpContext) continue;
    if (!cause.test.test(raw)) continue;
    return {
      server,
      kind: cause.kind,
      short: cause.short,
      say: cause.say(server ? `its MCP server "${server}"` : 'one of its MCP servers'),
    };
  }
  return null;
}

// The named causes worth translating. Each returns a sentence that says what to DO.
function knownCause(text) {
  const mcp = mcpFailure(text);
  if (mcp) return mcp.say;
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
