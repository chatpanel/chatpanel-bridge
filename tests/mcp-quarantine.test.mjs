// A CLI agent loads every MCP server in the user's own config on every run, so ONE server
// with an expired login (or a VPN-only host seen from a cafe) used to kill turns that never
// touched it. These are the rules that let ChatPanel drop it and carry on — and, just as
// importantly, the cases where it must NOT.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNames, quarantine, quarantined, resetQuarantine, disabledMcpServers, planMcpRetry,
} from '../src/mcp-quarantine.js';
import { codexDisableArgs, configuredMcpServers } from '../src/engines/codex.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXPIRED = 'ERROR oauth::refresh: error=failed to refresh OAuth tokens for server acme_wiki: OAuth refresh token was rejected: invalid_grant: refresh token does not exist';
const OFFLINE = 'ERROR mcp_connection_manager: MCP server `acme_wiki` failed to start and is unavailable. Continue without it.\n'
  + 'ERROR handshaking with MCP server failed: error sending request for url (https://wiki.example.com/mcp): dns error: failed to lookup address information';

beforeEach(() => resetQuarantine());

test('a named expired login is retried without that server', () => {
  const plan = planMcpRetry({ agent: 'codex', text: EXPIRED });
  assert.equal(plan.server, 'acme_wiki');
  assert.equal(plan.kind, 'expired');
  assert.match(plan.short, /login has expired/);
});

test('an unreachable server (off VPN) is retried too — the reported case', () => {
  const plan = planMcpRetry({ agent: 'codex', text: OFFLINE });
  assert.equal(plan.kind, 'unreachable');
  assert.ok(plan.server, 'names the server so there is something to disable');
});

test('a failure that names no server is never retried', () => {
  // Retrying would only fail the same way, and we would have disabled nothing.
  assert.equal(planMcpRetry({ agent: 'codex', text: 'Error: HTTP 403 <html>go away</html>' }), null);
  assert.equal(planMcpRetry({ agent: 'codex', text: 'error: model refused the request' }), null);
});

test("ChatPanel's own injected server is never routed around", () => {
  // Our server failing is our bug to surface; silently disabling it takes "Act on page" too.
  const text = 'ERROR: handshaking with MCP server `chatpanel_browser` failed: connection refused';
  assert.equal(planMcpRetry({ agent: 'codex', text, protect: ['chatpanel_browser'] }), null);
});

test('a server already dropped is not proposed again', () => {
  assert.equal(planMcpRetry({ agent: 'codex', text: EXPIRED, already: ['acme_wiki'] }), null);
  quarantine('codex', 'acme_wiki');
  assert.equal(planMcpRetry({ agent: 'codex', text: EXPIRED }), null, 'quarantine survives the turn');
});

test('quarantine is per agent and reports freshness', () => {
  assert.equal(quarantine('codex', 'acme_wiki'), true);
  assert.equal(quarantine('codex', 'acme_wiki'), false, 'second drop is not news');
  assert.deepEqual(quarantined('codex'), ['acme_wiki']);
  assert.deepEqual(quarantined('claude'), [], 'another CLI has its own config and its own state');
});

test('the deny list and the quarantine merge, minus our own server', () => {
  quarantine('codex', 'acme_wiki');
  const out = disabledMcpServers('codex', { mcpDisabled: 'sharepoint, acme_wiki chatpanel_browser' }, ['chatpanel_browser']);
  assert.deepEqual(out.sort(), ['acme_wiki', 'sharepoint']);
});

test('names are validated, not escaped — they become config override keys', () => {
  // `-c mcp_servers.<name>.enabled=false` is a TOML path, so anything that is not a plain
  // server name is dropped rather than quoted.
  // Dots are out too: Codex reads them as further path segments and rejects the quoted form.
  assert.deepEqual(normalizeNames('ok_1, a.b, "$(id)", ok-2'), ['ok_1', 'ok-2']);
  assert.deepEqual(normalizeNames(['dup', 'dup']), ['dup']);
  assert.equal(quarantine('codex', 'evil=true\nmodel'), false, 'a junk name is not quarantined');
  const args = codexDisableArgs(normalizeNames('acme_wiki, mcp_servers.x.command=evil'));
  assert.deepEqual(args, ['-c', 'mcp_servers.acme_wiki.enabled=false']);
});

test('only servers Codex already has configured may be disabled', () => {
  // Disabling an unknown name does not disable anything — it DEFINES a transport-less server,
  // and Codex then refuses to start at all. A stale quarantine entry would break every run.
  const home = mkdtempSync(path.join(tmpdir(), 'codex-home-'));
  writeFileSync(path.join(home, 'config.toml'), [
    'model = "gpt-5"',
    '[mcp_servers.acme_wiki]',
    'url = "https://wiki.example.com/mcp"',
    '[mcp_servers.acme_wiki.env]',
    'TOKEN = "x"',
    '  [mcp_servers.local-tool]',
    'command = "tool"',
  ].join('\n'));
  const known = configuredMcpServers(home);
  assert.deepEqual([...known].sort(), ['acme_wiki', 'local-tool'], 'headers only, sub-tables folded in');
  assert.deepEqual(configuredMcpServers('/no/such/home'), new Set(), 'no config = nothing to disable');
});
