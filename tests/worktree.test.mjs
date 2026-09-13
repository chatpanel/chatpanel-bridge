// A worktree per job on cp/<project>/<job>, and the pre-push leash that keeps a push on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'cp-wt-'));
process.env.CHATPANEL_WORKTREES = join(dir, 'worktrees');
process.env.CHATPANEL_GIT_HOOKS = join(dir, 'hooks');
const { worktreeFor, listWorktrees, removeWorktree, withHook, hookEnv, defaultBase } = await import('../src/worktree.js');

const sh = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
let haveGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { haveGit = false; }

// A bare "hub" and a clone the person has.
const hub = join(dir, 'hub.git'); const repo = join(dir, 'repo');
if (haveGit) {
  sh(dir, ['init', '--bare', '-b', 'main', hub]);
  sh(dir, ['clone', '-q', hub, repo]);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  sh(repo, ['add', 'a.txt']); sh(repo, ['commit', '-q', '-m', 'first']); sh(repo, ['push', '-q', '-u', 'origin', 'main']);
}

test('worktreeFor makes the checkout on the job branch from the default base, and reuses it', { skip: !haveGit && 'no git' }, async () => {
  assert.equal(await defaultBase(repo), 'main');
  const w = await worktreeFor({ repo, projectId: 'Naming Phase 2', jobId: 'events' });
  assert.equal(w.created, true); assert.equal(w.branch, 'cp/naming-phase-2/events'); assert.equal(w.base, 'main');
  assert.equal(w.path, join(process.env.CHATPANEL_WORKTREES, 'naming-phase-2', 'events'));
  assert.ok(existsSync(join(w.path, 'a.txt')));
  assert.equal(sh(w.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'cp/naming-phase-2/events');
  assert.equal(sh(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'the main checkout is untouched');
  const again = await worktreeFor({ repo, projectId: 'Naming Phase 2', jobId: 'events' });
  assert.equal(again.created, false); assert.equal(again.path, w.path);
  const other = await worktreeFor({ repo, projectId: 'naming-phase-2', jobId: 'gateway', base: 'main' });
  assert.notEqual(other.path, w.path);
  const list = await listWorktrees();
  assert.deepEqual(list.map((x) => x.job).sort(), ['events', 'gateway']);
  assert.match((await worktreeFor({ repo: join(dir, 'nowhere'), projectId: 'p', jobId: 'j' })).error, /no such repository/);
  assert.match((await worktreeFor({ repo: dir, projectId: 'p', jobId: 'j' })).error, /not a git checkout/);
});

test('the pre-push leash: own branch only under scm:push, nothing without it, and any branch when unleashed', { skip: !haveGit && 'no git' }, async () => {
  const w = await worktreeFor({ repo, projectId: 'p', jobId: 'leash' });
  writeFileSync(join(w.path, 'b.txt'), 'b\n');
  sh(w.path, ['add', 'b.txt']); sh(w.path, ['commit', '-q', '-m', 'work']);
  const hooks = hookEnv();
  assert.equal(hooks.CHATPANEL_GIT_HOOKS_KEY, 'core.hooksPath');
  const env = (mode) => withHook({ CHATPANEL_SCM_PUSH: mode, CHATPANEL_SCM_BRANCH: 'cp/p/leash', GIT_CONFIG_COUNT: '0' });
  assert.equal(env('own').GIT_CONFIG_KEY_0, 'core.hooksPath');
  // Own branch: allowed.
  sh(w.path, ['push', '-q', 'origin', 'cp/p/leash'], env('own'));
  assert.equal(sh(hub, ['rev-parse', '--verify', 'refs/heads/cp/p/leash']).length, 40);
  // Another branch (main) from the same worktree: refused by the hook.
  assert.throws(() => sh(w.path, ['push', '-q', 'origin', 'HEAD:main'], env('own')), /may push only its own branch/);
  assert.equal(sh(hub, ['rev-parse', 'refs/heads/main']), sh(repo, ['rev-parse', 'refs/heads/main']), 'main did not move');
  // No grant: refused outright.
  writeFileSync(join(w.path, 'c.txt'), 'c\n'); sh(w.path, ['add', 'c.txt']); sh(w.path, ['commit', '-q', '-m', 'more']);
  assert.throws(() => sh(w.path, ['push', '-q', 'origin', 'cp/p/leash'], env('none')), /no scm:push grant/);
  // Unleashed (no branch named, push granted): git's own rules.
  sh(w.path, ['push', '-q', 'origin', 'cp/p/leash'], env('any'));
  // The hook is process-scoped: without the env, the repository's git has no hook and pushes as ever.
  writeFileSync(join(w.path, 'd.txt'), 'd\n'); sh(w.path, ['add', 'd.txt']); sh(w.path, ['commit', '-q', '-m', 'plain']);
  sh(w.path, ['push', '-q', 'origin', 'cp/p/leash']);
  // Removal: the directory goes, the branch stays — it is the record.
  const r = await removeWorktree({ projectId: 'p', jobId: 'leash' });
  assert.equal(r.ok, true); assert.equal(existsSync(w.path), false);
  assert.equal(sh(repo, ['rev-parse', '--verify', 'refs/heads/cp/p/leash']).length, 40);
  assert.equal((await removeWorktree({ projectId: 'p', jobId: 'leash' })).ok, false);
});
