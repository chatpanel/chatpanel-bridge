import assert from 'node:assert/strict';
import test from 'node:test';

import { isBlockedHttpHost, isLoopbackHost, assertPublicHttpUrl } from '../src/ssrf.js';

// NOTE: ssrf.js reads CHATPANEL_BRIDGE_ALLOW_PRIVATE_HOSTS once at import time.
// These tests run with it unset (the default-deny posture).

test('loopback MCP servers are allowed (the "via bridge" localhost case)', () => {
  for (const h of ['127.0.0.1', '127.0.0.53', 'localhost', 'foo.localhost', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(h), true, `${h} should be loopback`);
    assert.equal(isBlockedHttpHost(h), false, `${h} should NOT be blocked`);
  }
  assert.doesNotThrow(() => assertPublicHttpUrl('http://127.0.0.1:4319/mcp'));
  assert.doesNotThrow(() => assertPublicHttpUrl('http://localhost:4319/mcp'));
});

test('cloud metadata is always blocked', () => {
  assert.equal(isBlockedHttpHost('169.254.169.254'), true);
  assert.throws(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'), /private\/metadata/);
});

test('private / LAN / internal ranges are blocked by default', () => {
  for (const h of [
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '100.64.0.1', // CGNAT
    '169.254.1.2', // link-local
    '0.0.0.0',
    '::',
    'fd00::1', // IPv6 ULA
    'fe80::1', // IPv6 link-local
    'printer.local', // mDNS
  ]) {
    assert.equal(isBlockedHttpHost(h), true, `${h} should be blocked`);
  }
});

test('public hosts pass through', () => {
  for (const h of ['example.com', 'api.openai.com', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
    assert.equal(isBlockedHttpHost(h), false, `${h} should NOT be blocked`);
  }
  assert.doesNotThrow(() => assertPublicHttpUrl('https://mcp.example.com/sse'));
});

test('non-http(s) schemes are rejected', () => {
  assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), /only http/);
  assert.throws(() => assertPublicHttpUrl('ftp://example.com/'), /only http/);
  assert.throws(() => assertPublicHttpUrl('gopher://example.com/'), /only http/);
});

test('malformed octets are not mistaken for IPs', () => {
  // 999.x is not a valid IPv4 → treated as a hostname, not a private IP.
  assert.equal(isBlockedHttpHost('999.0.0.1'), false);
  assert.throws(() => assertPublicHttpUrl('not a url'), /invalid URL/);
});
