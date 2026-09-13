// connections.js — the SCM connections this machine holds, and the token behind each.
//
// A connection RECORD (events/scm-connection.js) is the hub, its host, a secret's name and
// a reach; it is shared between the clients through the gateway's prefs document. The
// TOKEN is the one thing that never travels: it lives here, in the machine's keychain (macOS
// `security`), or — where there is no keychain — in a file only this user can read. The
// bridge is the process that spawns the coding agents, so it is the one that hands the
// token to git: for ONE run, in that process's environment, scoped to the connection's
// host, with a pre-push hook that keeps the push on the job's own branch (worktree.js).
//
// Nothing here logs a token, returns one over HTTP, or puts one on a command line.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import os from 'node:os';
import { normalizeConnection, connectionFor, credentialEnv, hostOf, parseRemote, describeConnection } from './events/scm-connection.js';

const DIR = join(os.homedir(), '.chatpanel');
const RECORDS_PATH = process.env.CHATPANEL_CONNECTIONS_PATH || join(DIR, 'connections.json');
const SECRETS_PATH = process.env.CHATPANEL_SECRETS_PATH || join(DIR, 'secrets.json');
const KEYCHAIN_ACCOUNT = 'chatpanel';

// ── The secret store: keychain where there is one, a 0600 file where there is not ────────

function keychainAvailable() {
  return process.platform === 'darwin' && !/^(0|false|no|off)$/i.test(process.env.CHATPANEL_USE_KEYCHAIN || '');
}
function security(args, input) {
  return execFileSync('security', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000, input, windowsHide: true });
}

function readSecretsFile() {
  try { return existsSync(SECRETS_PATH) ? JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) || {} : {}; } catch { return {}; }
}
function writeSecretsFile(doc) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${SECRETS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600 });
  renameSync(tmp, SECRETS_PATH);
}

/** Where a secret would be kept on this machine — reported, never the secret. */
export function secretBackend() { return keychainAvailable() ? 'keychain' : 'file'; }

export function setSecret(ref, token) {
  const r = String(ref || '').trim(); const t = String(token || '');
  if (!r) throw new Error('secretRef required');
  if (!t) return deleteSecret(r);
  if (keychainAvailable()) {
    // -U updates in place; the password goes over stdin-less argv of `security`, which is
    // the documented way and stays inside the loopback of this machine. The keychain item
    // is this user's, under the "chatpanel" account, named by the ref.
    try { security(['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', r, '-w', t, '-U']); return 'keychain'; }
    catch (e) { throw new Error(`keychain refused: ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}`); }
  }
  const doc = readSecretsFile(); doc[r] = t; writeSecretsFile(doc); return 'file';
}

export function getSecret(ref) {
  const r = String(ref || '').trim();
  if (!r) return null;
  if (keychainAvailable()) {
    try { return security(['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', r, '-w']).replace(/\n$/, '') || null; } catch { /* not there, or file below */ }
  }
  const v = readSecretsFile()[r];
  return typeof v === 'string' && v ? v : null;
}

export function hasSecret(ref) { return getSecret(ref) != null; }

export function deleteSecret(ref) {
  const r = String(ref || '').trim();
  if (!r) return false;
  let any = false;
  if (keychainAvailable()) { try { security(['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', r]); any = true; } catch { /* was not there */ } }
  const doc = readSecretsFile();
  if (r in doc) { delete doc[r]; writeSecretsFile(doc); any = true; }
  return any;
}

// ── The records ───────────────────────────────────────────────────────────────────────────

function readRecords() {
  try { const doc = existsSync(RECORDS_PATH) ? JSON.parse(readFileSync(RECORDS_PATH, 'utf8')) : null; return Array.isArray(doc?.connections) ? doc.connections : []; } catch { return []; }
}
function writeRecords(list) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${RECORDS_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: 1, connections: list }), { mode: 0o600 });
  renameSync(tmp, RECORDS_PATH);
}

/** Every connection, as a client may see it: the record plus whether a token is held. Never the token. */
export function listConnections() {
  return readRecords().map((c) => ({ ...c, hasSecret: hasSecret(c.secretRef), label: c.label || describeConnection(c) }));
}

/**
 * Save a connection; a `token` (optional) goes to the secret store under the record's
 * `secretRef` and is not in what comes back. A record that carries a token field of its
 * own is refused by `normalizeConnection` — that is the events contract, enforced here too.
 */
export function putConnection(record, { token = null } = {}) {
  const conn = normalizeConnection({ ...record, createdAt: record?.createdAt || Date.now() });
  const list = readRecords().filter((c) => c.id !== conn.id);
  list.push(conn);
  writeRecords(list);
  let stored = null;
  if (token) stored = setSecret(conn.secretRef, token);
  return { ...conn, hasSecret: hasSecret(conn.secretRef), ...(stored ? { secretStoredIn: stored } : {}) };
}

export function removeConnection(id) {
  const list = readRecords();
  const conn = list.find((c) => c.id === String(id || ''));
  if (!conn) return false;
  writeRecords(list.filter((c) => c.id !== conn.id));
  deleteSecret(conn.secretRef);
  return true;
}

/**
 * The environment a run gets for the checkout at `remote` — the matched connection's token,
 * scoped to its host, plus what the pre-push hook reads (worktree.js): the branch a push may
 * touch, and whether pushing is granted at all. `grants` are the role's (team.js): no
 * `scm:push` → the hook refuses every push; `scm:push` → the job's branch only. Without a
 * matching connection there is no token and the agent works as the user's own git does.
 */
export function runEnvFor({ remote = null, grants = [], branch = null, connectionId = null } = {}) {
  const list = readRecords();
  const conn = connectionId ? list.find((c) => c.id === connectionId && c.enabled !== false) || null : (remote ? connectionFor(remote, list) : null);
  const token = conn ? getSecret(conn.secretRef) : null;
  const env = conn && token ? credentialEnv(conn, token) : {};
  const g = Array.isArray(grants) ? grants.map(String) : [];
  const canPush = g.some((x) => x === 'scm:push' || x === 'scm:pr' || x === 'scm:merge');
  env.CHATPANEL_SCM_PUSH = canPush ? (branch ? 'own' : 'any') : 'none';
  if (branch) env.CHATPANEL_SCM_BRANCH = String(branch);
  return { env, connection: conn ? { id: conn.id, kind: conn.kind, host: hostOf(conn), hasSecret: !!token } : null };
}

/** For `POST /connections/:id/test`: can this connection read `remote`? Runs `git ls-remote` with the run env, never prints the token. */
export function testConnection(id, remote) {
  const conn = readRecords().find((c) => c.id === String(id || ''));
  if (!conn) return { ok: false, reason: 'no such connection' };
  const token = getSecret(conn.secretRef);
  if (!token) return { ok: false, reason: 'no token stored' };
  const r = parseRemote(remote || (conn.reach.find((x) => !x.endsWith('/*') && x.includes('/')) ? `https://${hostOf(conn)}/${conn.reach.find((x) => !x.endsWith('/*') && x.includes('/'))}` : ''));
  if (!r) return { ok: false, reason: 'give a repository to test against (owner/name or a URL)' };
  if (r.host !== hostOf(conn)) return { ok: false, reason: `${r.host} is not this connection's host (${hostOf(conn)})` };
  const url = `https://${r.host}/${r.owner}/${r.name}.git`;
  try {
    const out = execFileSync('git', ['ls-remote', '--symref', url, 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000, windowsHide: true, env: { ...process.env, ...credentialEnv(conn, token) } });
    const head = /^ref: refs\/heads\/(\S+)\tHEAD/m.exec(out)?.[1] || null;
    return { ok: true, remote: url, defaultBranch: head };
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e).replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '***').trim().slice(0, 300);
    return { ok: false, reason: msg || 'git ls-remote failed' };
  }
}
