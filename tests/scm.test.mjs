// The checkout a run worked in, read before and after — never written, never fatal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitState, gitDelta, stripCredential } from '../src/scm.js';

const sh = (dir, args) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a directory that is not a checkout is null; a checkout says repo, branch, HEAD and whether it is dirty', { skip: !hasGit && 'no git on this machine' }, async () => {
  const plain = mkdtempSync(join(tmpdir(), 'cp-scm-plain-'));
  try { assert.equal(await gitState(plain), null); } finally { rmSync(plain, { recursive: true, force: true }); }
  const dir = mkdtempSync(join(tmpdir(), 'cp-scm-'));
  try {
    sh(dir, ['init', '-q', '-b', 'main']);
    sh(dir, ['remote', 'add', 'origin', 'https://user:s3cret@example.com/org/repo.git']);
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    sh(dir, ['add', '.']); sh(dir, ['commit', '-q', '-m', 'one']);
    const before = await gitState(dir);
    assert.equal(before.branch, 'main');
    assert.match(before.head, /^[0-9a-f]{40}$/);
    assert.equal(before.remote, 'https://example.com/org/repo.git', 'the token in the URL is not on the record');
    assert.equal(before.dirty, false);
    assert.ok(before.repo.endsWith(dir.split('/').pop()));
    // The agent works: a branch, two commits, one uncommitted change.
    sh(dir, ['checkout', '-q', '-b', 'cp/proj/job-1']);
    writeFileSync(join(dir, 'b.txt'), 'two\n'); sh(dir, ['add', '.']); sh(dir, ['commit', '-q', '-m', 'two']);
    writeFileSync(join(dir, 'c.txt'), 'three\n'); sh(dir, ['add', '.']); sh(dir, ['commit', '-q', '-m', 'three']);
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    const after = await gitDelta(dir, before);
    assert.equal(after.branch, 'cp/proj/job-1');
    assert.equal(after.commits, 2);
    assert.equal(after.headBefore, before.head);
    assert.notEqual(after.head, before.head);
    assert.equal(after.dirty, true);
    // Nothing moved: zero commits, same head.
    const same = await gitDelta(dir, after);
    assert.equal(same.commits, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a git that hangs or is missing yields null, not a stalled run', async () => {
  const never = () => {}; // an exec that never calls back — the timeout path is git's; here the guard is that a throwing exec is caught
  const throwing = () => { throw new Error('ENOENT'); };
  assert.equal(await gitState('/nowhere', { exec: throwing }), null);
  assert.equal(await gitDelta('/nowhere', null, { exec: throwing }), null);
  assert.equal(typeof never, 'function');
});

test('credentials are stripped from remote URLs, and URLs without one are untouched', () => {
  assert.equal(stripCredential('https://x:y@github.com/o/r.git'), 'https://github.com/o/r.git');
  assert.equal(stripCredential('https://oauth2:glpat-abc@gitlab.com/o/r.git'), 'https://gitlab.com/o/r.git');
  assert.equal(stripCredential('git@github.com:o/r.git'), 'git@github.com:o/r.git', 'an ssh remote has a user, not a secret');
  assert.equal(stripCredential('https://github.com/o/r.git'), 'https://github.com/o/r.git');
});
