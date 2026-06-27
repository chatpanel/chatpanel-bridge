// SSRF guard for the /mcp-remote proxy.
//
// The bridge proxies ONE JSON-RPC message to a remote MCP server *from this
// machine* (no browser Origin header), so the extension can reach servers that
// reject browser origins. That route is already privileged — it requires the
// extension origin or the per-install bridge token, so a random web page cannot
// drive it. This guard is the second layer: even when driven by the extension,
// the bridge must not become a relay that a prompt-injected agent could point at
// cloud metadata or use to sweep the LAN.
//
// Policy:
//   • Loopback (127.0.0.0/8, ::1, localhost, *.localhost) → ALLOWED.
//     It's the user's own host — the same place the bridge runs, and a place the
//     extension can already fetch DIRECTLY. Proxying it grants no new reach; it
//     only drops the browser Origin header (the whole point of "via bridge").
//     Localhost MCP servers are the common case.
//   • Cloud instance metadata (169.254.169.254) → ALWAYS BLOCKED.
//     This is the sharpest SSRF target (credential theft) and is blocked even
//     when private hosts are opted in.
//   • Everything else private/internal (RFC1918, CGNAT, link-local, IPv6 ULA,
//     0.0.0.0, ::, *.local) → BLOCKED, unless the operator opts in with
//     CHATPANEL_BRIDGE_ALLOW_PRIVATE_HOSTS=1 (for reaching an MCP server on
//     another machine on a trusted LAN).
//   • Non-http(s) schemes → BLOCKED.
//
// The same checks run on the initial URL AND after any redirect.

const ALLOW_PRIVATE_HOSTS = /^(1|true|yes|on)$/i.test(
  process.env.CHATPANEL_BRIDGE_ALLOW_PRIVATE_HOSTS || '',
);

function ipv4(h) {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return o;
}

// Loopback = this host's own services. Reachable by the extension directly, so
// allowing the bridge to reach it adds no capability.
export function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  const o = ipv4(h);
  return !!(o && o[0] === 127);
}

// Cloud instance metadata — credential-theft vector. Always blocked.
function isMetadataHost(hostname) {
  const o = ipv4(hostname);
  return !!(o && o[0] === 169 && o[1] === 254);
}

export function isBlockedHttpHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (isLoopbackHost(h)) return false; // user's own host — allowed
  if (isMetadataHost(h)) return true; // never proxy cloud metadata, even when private is opted in
  if (ALLOW_PRIVATE_HOSTS) return false; // operator opted in to LAN/private targets

  // Default deny for the rest of the private/internal space.
  if (h.endsWith('.local')) return true; // mDNS / LAN
  if (
    h === '::' ||
    h.startsWith('fc') ||
    h.startsWith('fd') || // IPv6 ULA
    h.startsWith('fe8') ||
    h.startsWith('fe9') ||
    h.startsWith('fea') ||
    h.startsWith('feb') // IPv6 link-local
  ) {
    return true;
  }
  const o = ipv4(h);
  if (o) {
    const [a, b] = o;
    if (a === 0 || a === 10) return true; // this-host / RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  return false;
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
