// How long a relayed tool call may take — one rule for the relay and for the CLIs' own
// MCP timeouts, so neither gives up before the other.
//
// A spec may declare `timeoutMs` (additive to the /chat contract — older extensions send
// none and keep the two-minute default): a team run declares its budget plus the merge. Before
// this, a 300 s team hit the relay's flat 120 s, Claude Code was handed "tool call timed out"
// while the extension was still working, and ran the team a SECOND time; the first run's
// result then had nowhere to go.
export const RELAY_TIMEOUT_DEFAULT_MS = 120_000;
export const RELAY_TIMEOUT_MAX_MS = 60 * 60_000;

/** The relay's timeout for one tool of a session. */
export function relayTimeoutFor(specs, name) {
  const declared = Number((specs || []).find((s) => s?.name === name)?.timeoutMs) || 0;
  return Math.min(RELAY_TIMEOUT_MAX_MS, Math.max(RELAY_TIMEOUT_DEFAULT_MS, declared));
}

/** The longest any tool of a session may take — what a CLI's own MCP tool timeout is set to. */
export function relayTimeoutMax(specs) {
  return Math.max(RELAY_TIMEOUT_DEFAULT_MS, ...(specs || []).map((s) => relayTimeoutFor(specs, s?.name)));
}
