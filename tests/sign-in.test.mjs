// "Not signed in" is an instruction, not an exit code — before the turn (the availability
// probe asks the CLI) and after it (the output is recognised). ChatPanel cannot sign in for
// the user, so the sentence names the command.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { loginRequired, signInMessage, signInStatus, resetSignInCache, SIGN_IN_HINTS } from '../src/sign-in.js';
import { summarizeCliError } from '../src/cli-errors.js';

test('loginRequired recognises the CLIs\' wording and leaves MCP-server auth failures alone', () => {
  for (const t of ['Not logged in · Please run /login', 'authentication_failed', 'Not logged in. Run `codex login`', 'Invalid API key · Please run /login', 'Error: not authenticated', 'HTTP 401 Unauthorized']) assert.equal(loginRequired(t), true, t);
  for (const t of ['failed to refresh OAuth tokens for MCP server jira: invalid_grant', 'Error: ENOENT claude', '', 'the model returned nothing']) assert.equal(loginRequired(t), false, t);
});

test('the message says nothing was sent, names the command, and that ChatPanel cannot do it', () => {
  const m = signInMessage('Claude Code', 'claude');
  assert.match(m, /was not sent/); assert.match(m, /run `claude`, and type `\/login`/); assert.match(m, /can't sign in for you/); assert.match(m, /send your message again/);
  assert.match(signInMessage('Codex', 'codex'), /`codex login`/);
  assert.match(signInMessage('Some CLI', 'unknown'), /sign in to Some CLI in your terminal/);
  assert.ok(Object.keys(SIGN_IN_HINTS).length >= 6);
});

test('summarizeCliError puts sign-in first and drops the exit code — "exited 1" told the user nothing', () => {
  assert.match(summarizeCliError('Claude Code', 1, '', 'Not logged in · Please run /login'), /^Claude Code isn't signed in/);
  assert.match(summarizeCliError('Codex', 1, 'Not logged in. Run codex login'), /^Codex isn't signed in.*`codex login`/);
  assert.match(summarizeCliError('Claude Code', 1, 'Error: something else'), /^Claude Code exited 1: /, 'other failures keep the code');
  assert.match(summarizeCliError('Claude Code', 1, 'failed to refresh OAuth tokens for MCP server jira: invalid_grant'), /re-authentication/, 'an MCP server\'s login is a different story');
});

const fakeSpawn = (stdout, code = 0) => () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.kill = () => {}; setImmediate(() => { c.stdout.emit('data', Buffer.from(stdout)); c.emit('close', code); }); return c; };
const spec = { kind: 'native', bin: '/x/claude' };

test('signInStatus: a clear no is false, a clear yes is true, anything else is null (never a guess); cached briefly', async () => {
  resetSignInCache();
  assert.equal(await signInStatus('claude', spec, { spawnImpl: fakeSpawn('{"loggedIn":false,"authMethod":"none"}', 1) }), false);
  assert.equal(await signInStatus('claude', spec, { spawnImpl: fakeSpawn('{"loggedIn":true}') , now: Date.now() + 60_000 }), true);
  resetSignInCache();
  assert.equal(await signInStatus('claude', spec, { spawnImpl: fakeSpawn('Usage: claude [options]', 1) }), null, 'an old CLI without `auth status` is not "not signed in"');
  resetSignInCache();
  assert.equal(await signInStatus('codex', spec, { spawnImpl: fakeSpawn('Not logged in\n', 1) }), false);
  resetSignInCache();
  assert.equal(await signInStatus('codex', spec, { spawnImpl: fakeSpawn('Logged in using ChatGPT\n') }), true);
  assert.equal(await signInStatus('opencode', spec, { spawnImpl: fakeSpawn('x') }), null, 'no status command known: no claim');
  resetSignInCache();
  let calls = 0;
  const counting = () => { calls += 1; return fakeSpawn('{"loggedIn":false}', 1)(); };
  await signInStatus('claude', spec, { spawnImpl: counting }); await signInStatus('claude', spec, { spawnImpl: counting });
  assert.equal(calls, 1, 'the second ask within the TTL is answered from the cache');
  resetSignInCache();
});
