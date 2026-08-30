// workdir.js — where an agent's files actually go.
//
// This existed five times with four different answers, none of them told to the user:
//
//   claude (CLI)   cwd: null  → inherits the BRIDGE's cwd, which under launchd is `/`
//   claude (SDK)   ~
//   codex          /tmp/chatpanel-codex-scratch
//   antigravity    /tmp/chatpanel-agy-scratch
//   custom         cwd: null  → `/` again
//
// So "the agent created a file and I cannot find it" was not user error. Depending on
// which agent answered, the file was at the filesystem root, in the home directory, or in
// a temp folder the OS deletes on its own schedule.
//
// One default, and it is neither `/` nor a temp directory: `~/.chatpanel/workspace`.
// Persistent, predictable, obviously ChatPanel's, and somewhere a person can navigate to.
// A user who wants files elsewhere sets Working directory on the agent — which is what
// that field was always for; it just had an invisible and inconsistent fallback.
//
// The path is REPORTED, not just chosen: /health carries it so Settings can show what a
// blank field resolves to, and every run announces it, because a default nobody can see
// is the same problem in a nicer location.

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where files land when an agent has no Working directory set. */
export const DEFAULT_WORKSPACE = path.join(os.homedir(), '.chatpanel', 'workspace');

/**
 * Resolve an agent's working directory, creating it if needed.
 *
 * Always returns a real, absolute path — never null. Inheriting the bridge's own cwd is
 * what produced `/`, and a process spawned at `/` either refuses to write or writes
 * somewhere nobody will look.
 *
 * Creation failure is not fatal: the agent may not need to write at all, and refusing to
 * answer a question because a directory could not be made would be a worse failure than
 * the one it prevents. The caller still gets the path, and the CLI reports its own error
 * if it turns out to matter.
 */
export function resolveWorkdir(workingDir) {
  const dir = workingDir && String(workingDir).trim()
    ? path.resolve(String(workingDir).trim())
    : DEFAULT_WORKSPACE;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* reported by whatever tries to write */
  }
  return dir;
}

/** True when this run is using the default rather than a directory the user chose. */
export function isDefaultWorkdir(workingDir) {
  return !(workingDir && String(workingDir).trim());
}

/**
 * How a path should read in a tool step.
 *
 * `path.basename` was used here, so a step said "foo.js" and left the user to guess which
 * of the four possible roots it meant. Relative-to-cwd says where it is without pasting an
 * absolute path into every line; anything OUTSIDE the working directory keeps its full
 * path, because that is exactly the case worth noticing.
 *
 * `impl` is the path flavour, injected so the Windows and POSIX rules can both be tested
 * on whichever machine happens to run the suite. The bridge ships to macOS, Linux AND
 * Windows, and a display rule that is only ever exercised on one of them is a display rule
 * that is wrong on the other two.
 */
export function displayPath(filePath, cwd, impl = path) {
  const p = String(filePath || '');
  if (!p) return '';
  if (!cwd || !impl.isAbsolute(p)) return p;
  const rel = impl.relative(cwd, p);
  if (!rel) return '.';
  // Two ways out of the working directory, and Windows only has one of them in common
  // with POSIX: `..` for a sibling, and a wholly different ROOT (another drive, a UNC
  // share) for which `relative` hands back an absolute path rather than any `..` at all.
  if (rel.startsWith('..') || impl.isAbsolute(rel)) return p;
  return rel;
}

/**
 * Whether this engine+mode confines writes to the working directory, and how to say so.
 *
 * Codex's `acceptEdits` maps to `--sandbox workspace-write`, which permits writes ONLY
 * inside the cwd. That is correct sandboxing and it is also the most confusing failure the
 * bridge produces: the agent reports that it could not write a file, the user checks that
 * "auto-edit files" is on, and nothing anywhere mentions that the boundary is a DIRECTORY
 * rather than a permission. It bit hardest before there was a sensible default, when a
 * blank field meant a temp folder — so every attempt to edit a real project was outside
 * the sandbox by construction.
 *
 * Stated up front rather than detected on failure: a denial does not necessarily fail the
 * run (Codex reports it as a failed tool call and carries on), so there is no reliable
 * error to attach an explanation to.
 */
export function writeScopeNote(engineId, permissionMode, cwd) {
  if (engineId !== 'codex') return '';
  if (permissionMode === 'bypassPermissions') return '';
  if (permissionMode !== 'acceptEdits') {
    return 'Codex is read-only in this mode — set Permissions to “auto-edit files” to let it write.';
  }
  return `Codex may only create or edit files inside ${cwd}. To work on another project, set this agent’s Working directory to it.`;
}
