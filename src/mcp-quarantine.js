// Why a turn should not die because a server it never used could not log in.
//
// A CLI agent loads EVERY MCP server in the user's own config on every single run. One that
// cannot authenticate — an expired OAuth token, a VPN-only host seen from a coffee shop —
// takes the whole turn down with it, even when the question had nothing to do with that
// server. The user is then told to go re-login to something they never asked for.
//
// So: read the failure, name the server, drop it, run again. Two ways in —
//   1. the user's own deny list (`options.mcpDisabled`), for servers they know they don't
//      want ChatPanel to load at all; and
//   2. QUARANTINE — a server that just killed a run is dropped automatically and stays
//      dropped for the rest of the bridge's session, since it will not have healed in the
//      twenty seconds before the next message.
//
// Two rules keep this honest. It is never silent: dropping a tool without saying so is worse
// than failing loudly, so the engine emits a status line naming what it skipped. And it never
// drops ChatPanel's OWN injected server — that one failing is our bug to surface, not a
// nuisance to route around (silently disabling it would take "Act on page" with it).
//
// Engine-agnostic on purpose: Codex renders this as `-c mcp_servers.X.enabled=false`, Claude
// Code and Copilot as their own flags, but the POLICY — which servers may load this turn —
// is one decision, made here, not re-derived per engine.

import { mcpFailure } from './cli-errors.js';

// A server that failed is dropped for this long. Long enough that a chat session never pays
// the same failed startup twice; short enough that reconnecting the VPN and waiting a while
// brings the server back without restarting the bridge.
const TTL_MS = Number(process.env.CHATPANEL_MCP_QUARANTINE_MS) || 30 * 60_000;

const dropped = new Map(); // `${agent} ${server}` -> expiry epoch ms

const key = (agent, server) => `${agent} ${server}`;

function prune(now = Date.now()) {
  for (const [k, expiry] of dropped) if (expiry <= now) dropped.delete(k);
}

/**
 * Server names are interpolated into a config override key (`mcp_servers.<name>.enabled`),
 * so they are validated rather than escaped: anything that isn't a plain MCP server name is
 * dropped. Dots are excluded too — Codex's `-c` parser reads them as further path segments
 * and rejects the quoted form. Accepts an array or a comma/space-separated string (what the
 * settings field holds).
 */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** One name, validated whole — no splitting, so junk is rejected rather than chopped valid. */
export function validName(value) {
  const name = String(value || '').trim();
  return NAME_RE.test(name) ? name : null;
}

export function normalizeNames(value) {
  const list = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  const out = [];
  for (const raw of list) {
    const name = validName(raw);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The servers currently quarantined for an agent. */
export function quarantined(agent) {
  prune();
  const prefix = key(agent, '');
  return [...dropped.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
}

/** Drop a server for this agent. Returns false when it was already dropped. */
export function quarantine(agent, server) {
  const name = validName(server);
  if (!name) return false;
  const k = key(agent, name);
  const fresh = !dropped.has(k);
  dropped.set(k, Date.now() + TTL_MS);
  return fresh;
}

/** Test seam — the store is process-global by design. */
export function resetQuarantine() {
  dropped.clear();
}

/**
 * Every server this run must not load: the user's deny list plus anything quarantined,
 * minus the servers ChatPanel itself injected (never route around our own).
 */
export function disabledMcpServers(agent, options = {}, protect = []) {
  const guard = new Set(normalizeNames(protect));
  const names = [...normalizeNames(options.mcpDisabled), ...quarantined(agent)];
  return [...new Set(names)].filter((n) => !guard.has(n));
}

/**
 * Should this failed run be retried without one of the agent's own MCP servers?
 * Returns the server to drop, or null — and null is the safe answer: a failure that names no
 * server, or names one we already dropped, means retrying would only fail the same way.
 * @returns {{server: string, kind: string, short: string}|null}
 */
export function planMcpRetry({ agent = '', text = '', protect = [], already = [] } = {}) {
  const failure = mcpFailure(text);
  if (!failure?.server) return null;
  if (!validName(failure.server)) return null; // a name we could never write as an override
  if (normalizeNames(protect).includes(failure.server)) return null;
  if (normalizeNames(already).includes(failure.server)) return null;
  if (quarantined(agent).includes(failure.server)) return null;
  return { server: failure.server, kind: failure.kind, short: failure.short };
}
