// SSRF guard for the bridge's outbound proxies (/mcp-remote, /fetch-title).
//
// The host CLASSIFICATION (what is loopback / cloud-metadata / RFC1918 / CGNAT /
// ULA / link-local / .local) now lives in ONE shared place — src/net.js, a vendored
// copy of @chatpanel/pii/net.js, the same classifier the gateway and extension use.
// This file keeps only the bridge's two POLICIES + their exact error messages, so a
// security guard can't drift between the direct client path and the proxied path.
// See docs/secure-data-plane.md.
//
// Two policies:
//   • /mcp-remote (assertPublicHttpUrl): loopback ALLOWED (the user's own MCP
//     servers — the whole point of "via bridge"), cloud metadata ALWAYS blocked,
//     every other private/LAN range blocked UNLESS the operator opts in with
//     CHATPANEL_BRIDGE_ALLOW_PRIVATE_HOSTS=1 (reaching an MCP server on a trusted LAN).
//   • /fetch-title (assertPublicWebUrl): STRICTER — a page fetch has no business
//     touching loopback OR any private host, so loopback + metadata + every private
//     range are blocked unconditionally (the opt-in is deliberately NOT honored).
//
// Non-http(s) schemes are blocked in both. Run the assert on the initial URL AND
// after every redirect hop.

import { isLoopbackHost, isBlockedHost } from './net.js';

export { isLoopbackHost };

const ALLOW_PRIVATE_HOSTS = /^(1|true|yes|on)$/i.test(
  process.env.CHATPANEL_BRIDGE_ALLOW_PRIVATE_HOSTS || '',
);

// MCP-proxy policy: loopback ok, metadata never, other private only when opted in.
export function isBlockedHttpHost(hostname) {
  return isBlockedHost(hostname, { allowLoopback: true, allowPrivate: ALLOW_PRIVATE_HOSTS });
}

export function assertPublicHttpUrl(u) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`invalid URL: ${u}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`only http(s) URLs allowed (got "${parsed.protocol}")`);
  }
  if (isBlockedHttpHost(parsed.hostname)) {
    throw new Error(`refusing to proxy a private/metadata address (${parsed.hostname})`);
  }
  return parsed;
}

// Web-fetch policy (stricter): block loopback + metadata + all private, always.
export function isDisallowedWebHost(hostname) {
  return isBlockedHost(hostname, { allowLoopback: false, allowPrivate: false });
}

export function assertPublicWebUrl(u) {
  let parsed;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error(`invalid URL: ${u}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`only http(s) URLs allowed (got "${parsed.protocol}")`);
  }
  if (isDisallowedWebHost(parsed.hostname)) {
    throw new Error(`refusing to fetch a private/loopback/metadata address (${parsed.hostname})`);
  }
  return parsed;
}
