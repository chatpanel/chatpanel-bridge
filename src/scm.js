// scm.js — what a run did in a git checkout, said on the record.
//
// The repository is the source of truth for a project that is code (architecture-pillars.md
// §14): the board holds the conversation, the job board the intent, but what an agent DID
// lives in branches and commits in the hub the organisation already uses. The bridge adds
// no git client — the coding agents know `git` — but it is the one process that knows
// where the agent worked and can look before and after, so it reports: which repo, which
// branch, HEAD when the run started, HEAD when it ended, and how many commits lie between.
// The runner puts that on the task and on the agent's scorecard, where a merged PR will be
// the one outcome fact that does not come from a judge.
//
// Read-only, never writes, never fails a run: a directory that is not a checkout, or a
// machine without git, is `null` and nothing is announced. Every call is bounded by a short
// timeout — `git` on a network filesystem must not stall a chat.

import { execFile } from 'node:child_process';

const GIT_TIMEOUT_MS = 2500;

/** One git query; '' on any failure (no git, not a repo, timed out). */
function git(dir, args, { exec = execFile } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      exec('git', ['-C', dir, ...args], { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => finish(err ? '' : String(stdout || '').trim()));
    } catch { finish(''); }
  });
}

/**
 * The checkout at `dir`, or null. `{ repo, remote, branch, head, dirty }` — `repo` is the
 * worktree's top level, `remote` the origin URL when there is one (with any credential
 * stripped: a token in a URL is not something to put on a record), `branch` the current one
 * ('HEAD' when detached), `head` the full commit, `dirty` whether anything is uncommitted.
 */
export async function gitState(dir, opts = {}) {
  if (!dir) return null;
  const repo = await git(dir, ['rev-parse', '--show-toplevel'], opts);
  if (!repo) return null;
  const [branch, head, remote, status] = await Promise.all([
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], opts),
    git(dir, ['rev-parse', 'HEAD'], opts),
    git(dir, ['remote', 'get-url', 'origin'], opts),
    git(dir, ['status', '--porcelain', '--untracked-files=no'], opts),
  ]);
  return {
    repo,
    ...(remote ? { remote: stripCredential(remote) } : {}),
    branch: branch || 'HEAD',
    ...(head ? { head } : {}),
    dirty: status.length > 0,
  };
}

/** `https://user:token@host/…` → `https://host/…`. */
export function stripCredential(url) {
  return String(url || '').replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
}

/**
 * What the run changed: the state after, plus `commits` — how many lie between the HEAD it
 * started at and the HEAD it ended at (0 when unchanged or unknowable). `before` is what
 * `gitState` returned at the start; a run that began outside a checkout can still end in
 * one (an agent that cloned), so `after` is read regardless.
 */
export async function gitDelta(dir, before, opts = {}) {
  const after = await gitState(dir, opts);
  if (!after) return null;
  let commits = 0;
  if (before?.head && after.head && before.head !== after.head) {
    const n = await git(dir, ['rev-list', '--count', `${before.head}..${after.head}`], opts);
    commits = Number(n) || 0;
  }
  return { ...after, ...(before?.head ? { headBefore: before.head } : {}), commits };
}
