// worktree.js — a checkout per job, and the hook that keeps its pushes on its own branch.
//
// An Implementer works in a WORKTREE of the repository (architecture-pillars.md §14.2):
// `git worktree add` under ~/.chatpanel/worktrees/<project>/<job> on the branch
// `cp/<project>/<job>`, from the base the job names (the repo's default branch when it
// names none). Two jobs on one repo never share a working directory; the main checkout is
// never touched; a person can open the directory and look. The bridge adds no git client —
// `git` does the work, bounded, and a failure is reported, never hidden.
//
// THE PRE-PUSH HOOK is how "push your own branch" is enforced without inspecting what the
// agent types: the run's environment sets `core.hooksPath` to a directory the bridge
// owns, whose `pre-push` refuses any ref that is not the job's branch (and every push when
// the role has no `scm:push`). The repository's own pre-push, if it has one, still runs
// after ours. This is process-scoped like the credential: the hook is not installed in the
// repository and does not survive the run.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import { branchFor, worktreeDirFor } from './events/scm-connection.js';

export const WORKTREE_ROOT = process.env.CHATPANEL_WORKTREES || join(os.homedir(), '.chatpanel', 'worktrees');
export const HOOKS_DIR = process.env.CHATPANEL_GIT_HOOKS || join(os.homedir(), '.chatpanel', 'git-hooks');
const GIT_TIMEOUT_MS = 60_000; // a worktree add checks files out; a network filesystem is slow

const PRE_PUSH = `#!/bin/sh
# ChatPanel's pre-push — process-scoped through core.hooksPath for one agent run.
# Refuses every push when CHATPANEL_SCM_PUSH=none, and any ref but the job's own branch
# when CHATPANEL_SCM_PUSH=own. Then runs the repository's own pre-push, if there is one.
mode="\${CHATPANEL_SCM_PUSH:-any}"
own="\${CHATPANEL_SCM_BRANCH:-}"
if [ "$mode" = "none" ]; then
  echo "chatpanel: this role has no scm:push grant — the push was refused" >&2
  exit 1
fi
if [ "$mode" = "own" ]; then
  while read -r local_ref local_sha remote_ref remote_sha; do
    [ -z "$local_ref" ] && continue
    case "$remote_ref" in
      "refs/heads/$own") ;;
      *) echo "chatpanel: this job may push only its own branch ($own), not \${remote_ref#refs/heads/}" >&2; exit 1 ;;
    esac
  done
fi
repo_hook="$(git rev-parse --git-common-dir 2>/dev/null)/hooks/pre-push"
if [ -x "$repo_hook" ]; then exec "$repo_hook" "$@"; fi
exit 0
`;

/** The hooks directory, written once; the env that points one process's git at it. */
export function hookEnv() {
  try {
    mkdirSync(HOOKS_DIR, { recursive: true, mode: 0o700 });
    const p = join(HOOKS_DIR, 'pre-push');
    if (!existsSync(p) || readFileSync(p, 'utf8') !== PRE_PUSH) { writeFileSync(p, PRE_PUSH, { mode: 0o755 }); chmodSync(p, 0o755); }
  } catch { return {}; }
  return { CHATPANEL_GIT_HOOKS_KEY: 'core.hooksPath', CHATPANEL_GIT_HOOKS_VALUE: HOOKS_DIR };
}

/**
 * Merge the hook into a credential env (events/scm-connection.js `credentialEnv`) — both
 * use GIT_CONFIG_COUNT, so the hook's pair is appended at the next index.
 */
export function withHook(env) {
  const h = hookEnv();
  if (!h.CHATPANEL_GIT_HOOKS_KEY) return env;
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  const { CHATPANEL_GIT_HOOKS_KEY: k, CHATPANEL_GIT_HOOKS_VALUE: v } = h;
  return { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: k, [`GIT_CONFIG_VALUE_${n}`]: v };
}

function git(dir, args, { exec = execFile, env = process.env } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      exec('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 22, env }, (err, stdout, stderr) => finish({ ok: !err, out: String(stdout || '').trim(), err: err ? String(stderr || err.message || '').trim() : '' }));
    } catch (e) { finish({ ok: false, out: '', err: String(e?.message || e) }); }
  });
}

/** The repository's default branch as the remote says, else `main`/`master` if either exists, else HEAD. */
export async function defaultBase(repo, opts) {
  const sym = await git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], opts);
  if (sym.ok && sym.out) return sym.out; // origin/main
  for (const b of ['main', 'master']) { const r = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], opts); if (r.ok) return b; }
  return 'HEAD';
}

/**
 * The worktree for a job — created on first use, reused after. `repo` is a local checkout
 * the person already has (the clone the org's Repo record points at); `base` a branch,
 * tag or commit. Returns `{ path, branch, base, created, repo }` or `{ error }`.
 */
export async function worktreeFor({ repo, projectId, jobId, base = null, root = WORKTREE_ROOT }, opts = {}) {
  const dir = resolve(String(repo || ''));
  if (!dir || !existsSync(dir)) return { error: `no such repository: ${repo || '(blank)'}` };
  const top = await git(dir, ['rev-parse', '--show-toplevel'], opts);
  if (!top.ok || !top.out) return { error: `${dir} is not a git checkout` };
  const branch = branchFor(projectId, jobId);
  const path = join(root, worktreeDirFor(projectId, jobId));
  // Already there and registered to this repo → reuse.
  const list = await git(top.out, ['worktree', 'list', '--porcelain'], opts);
  const known = list.ok && list.out.split('\n').some((l) => l.startsWith('worktree ') && samePath(l.slice(9), path));
  if (known && existsSync(path)) {
    const cur = await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], opts);
    return { path, branch: cur.ok ? cur.out : branch, base: base || null, created: false, repo: top.out };
  }
  const from = base || await defaultBase(top.out, opts);
  mkdirSync(resolve(path, '..'), { recursive: true });
  const exists = await git(top.out, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], opts);
  const add = exists.ok
    ? await git(top.out, ['worktree', 'add', path, branch], opts)
    : await git(top.out, ['worktree', 'add', '-b', branch, path, from], opts);
  if (!add.ok) return { error: `git worktree add failed: ${add.err.slice(0, 300)}` };
  return { path, branch, base: from, created: true, repo: top.out };
}

const samePath = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return resolve(a) === resolve(b); } };

/** Every worktree the bridge made, from the root directory, with what git says about each. */
export async function listWorktrees({ root = WORKTREE_ROOT } = {}, opts = {}) {
  const out = [];
  if (!existsSync(root)) return out;
  const { readdirSync } = await import('node:fs');
  for (const p of readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const j of readdirSync(join(root, p.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const path = join(root, p.name, j.name);
      const [branch, top] = await Promise.all([git(path, ['rev-parse', '--abbrev-ref', 'HEAD'], opts), git(path, ['rev-parse', '--git-common-dir'], opts)]);
      out.push({ project: p.name, job: j.name, path, branch: branch.ok ? branch.out : null, repo: top.ok ? resolve(path, top.out).replace(/\/\.git$/, '') : null });
    }
  }
  return out;
}

/** Remove a job's worktree (`git worktree remove`); the branch stays — it is the record. */
export async function removeWorktree({ projectId, jobId, root = WORKTREE_ROOT, force = false }, opts = {}) {
  const path = join(root, worktreeDirFor(projectId, jobId));
  if (!existsSync(path)) return { ok: false, error: 'no such worktree' };
  const top = await git(path, ['rev-parse', '--git-common-dir'], opts);
  if (!top.ok) return { ok: false, error: `${path} is not a worktree` };
  const repo = resolve(path, top.out).replace(/\/\.git$/, '');
  const r = await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path], opts);
  return r.ok ? { ok: true, path } : { ok: false, error: r.err.slice(0, 300) };
}
