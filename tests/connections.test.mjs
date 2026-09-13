// SCM connections: the record is shareable, the token is not — it lives in the secret store
// and reaches git only through one process's environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'cp-conn-'));
process.env.CHATPANEL_CONNECTIONS_PATH = join(dir, 'connections.json');
process.env.CHATPANEL_SECRETS_PATH = join(dir, 'secrets.json');
process.env.CHATPANEL_USE_KEYCHAIN = '0';
const { listConnections, putConnection, removeConnection, runEnvFor, getSecret, hasSecret, secretBackend, testConnection } = await import('../src/connections.js');

test('a connection is saved without its token; the token goes to the secret store and is reported only as hasSecret', () => {
  assert.equal(secretBackend(), 'file');
  const saved = putConnection({ id: 'gh', kind: 'github', reach: ['acme/*'] }, { token: 'ghp_secret' });
  assert.equal(saved.hasSecret, true); assert.equal(saved.secretStoredIn, 'file');
  assert.equal(saved.token, undefined);
  const records = readFileSync(process.env.CHATPANEL_CONNECTIONS_PATH, 'utf8');
  assert.equal(records.includes('ghp_secret'), false, 'the record file never holds the token');
  assert.equal((statSync(process.env.CHATPANEL_SECRETS_PATH).mode & 0o777), 0o600);
  assert.equal(getSecret('chatpanel:scm:gh'), 'ghp_secret');
  const list = listConnections();
  assert.equal(list.length, 1); assert.equal(list[0].hasSecret, true); assert.equal(JSON.stringify(list).includes('ghp_secret'), false);
  assert.throws(() => putConnection({ id: 'bad', kind: 'github', token: 'x' }), /never stores a secret/, 'a token on the record is refused');
  // Re-saving keeps the token; saving with a new one replaces it.
  putConnection({ id: 'gh', kind: 'github', reach: ['acme/*', 'acme/app'] });
  assert.equal(hasSecret('chatpanel:scm:gh'), true);
  putConnection({ id: 'gh', kind: 'github' }, { token: 'ghp_new' });
  assert.equal(getSecret('chatpanel:scm:gh'), 'ghp_new');
});

test('the run env: the matching connection’s token scoped to its host, and the push leash from the grants', () => {
  putConnection({ id: 'gl', kind: 'gitlab' }, { token: 'glpat' });
  const r = runEnvFor({ remote: 'git@github.com:acme/app.git', grants: ['shell', 'scm:push'], branch: 'cp/p/j' });
  assert.equal(r.connection.id, 'gh'); assert.equal(r.connection.hasSecret, true);
  assert.equal(r.env.CHATPANEL_SCM_TOKEN, 'ghp_new'); assert.equal(r.env.GH_TOKEN, 'ghp_new');
  assert.equal(r.env.GIT_CONFIG_KEY_0, 'credential.https://github.com.helper');
  assert.equal(r.env.CHATPANEL_SCM_PUSH, 'own'); assert.equal(r.env.CHATPANEL_SCM_BRANCH, 'cp/p/j');
  const ro = runEnvFor({ remote: 'https://github.com/acme/app', grants: ['shell', 'scm:read'] });
  assert.equal(ro.env.CHATPANEL_SCM_PUSH, 'none', 'no scm:push → every push refused');
  assert.equal(ro.env.CHATPANEL_SCM_TOKEN, 'ghp_new', 'read still gets the token');
  const none = runEnvFor({ remote: 'https://bitbucket.org/x/y', grants: ['scm:pr'] });
  assert.equal(none.connection, null); assert.equal(none.env.CHATPANEL_SCM_TOKEN, undefined);
  assert.equal(none.env.CHATPANEL_SCM_PUSH, 'any', 'granted, no branch named: the user’s own git rules apply');
  const byId = runEnvFor({ remote: 'https://github.com/acme/app', connectionId: 'gl', grants: [] });
  assert.equal(byId.connection.id, 'gl'); assert.equal(byId.env.GITLAB_TOKEN, 'glpat');
});

test('removing a connection removes its token; a test without a repository says what it needs', () => {
  assert.equal(testConnection('gh').ok, false);
  assert.match(testConnection('gh').reason, /give a repository/);
  assert.match(testConnection('gh', 'https://gitlab.com/a/b').reason, /not this connection's host/);
  assert.equal(testConnection('nope').reason, 'no such connection');
  assert.equal(removeConnection('gh'), true);
  assert.equal(hasSecret('chatpanel:scm:gh'), false);
  assert.equal(removeConnection('gh'), false);
  assert.deepEqual(listConnections().map((c) => c.id), ['gl']);
});
