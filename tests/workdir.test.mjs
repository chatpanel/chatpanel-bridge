// Where an agent's files go.
//
// This was five implementations with four answers — `/` for the Claude CLI (it inherited
// the bridge's own cwd, which launchd sets to the filesystem root), `~` for the SDK
// fallback, and two different /tmp scratch folders for Codex and Antigravity. None of them
// was reported anywhere, so "the agent made a file and I cannot find it" was the expected
// outcome rather than a bug report.
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_WORKSPACE, displayPath, isDefaultWorkdir, resolveWorkdir, writeScopeNote } from '../src/workdir.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the default is persistent and obviously ChatPanel’s — not / and not a temp dir', () => {
  assert.equal(DEFAULT_WORKSPACE, path.join(os.homedir(), '.chatpanel', 'workspace'));
  assert.notEqual(DEFAULT_WORKSPACE, '/');
  assert.ok(!DEFAULT_WORKSPACE.startsWith(os.tmpdir()), 'a temp folder the OS clears is not a workspace');
});

test('resolve always returns a real absolute path, never null', () => {
  // Returning null is what made the CLI inherit the bridge's cwd in the first place.
  for (const blank of [undefined, null, '', '   ']) {
    assert.equal(resolveWorkdir(blank), DEFAULT_WORKSPACE);
  }
  assert.ok(existsSync(DEFAULT_WORKSPACE), 'the default is created, so an agent can write immediately');
});

test('a chosen directory wins and is resolved absolutely', () => {
  const dir = path.join(os.tmpdir(), `cp-workdir-${process.pid}`);
  try {
    assert.equal(resolveWorkdir(dir), dir);
    assert.equal(resolveWorkdir(`  ${dir}  `), dir, 'a pasted path with whitespace still works');
    assert.ok(existsSync(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failure to create the directory does not fail the run', () => {
  // The agent may not need to write at all. Refusing to answer a question because a
  // directory could not be made would be a worse failure than the one it prevents.
  const impossible = path.join('/proc-does-not-exist-here', 'nope');
  assert.equal(resolveWorkdir(impossible), path.resolve(impossible));
});

test('isDefault distinguishes "not set" from "set to something"', () => {
  assert.equal(isDefaultWorkdir(''), true);
  assert.equal(isDefaultWorkdir('   '), true);
  assert.equal(isDefaultWorkdir(undefined), true);
  assert.equal(isDefaultWorkdir('/tmp/x'), false);
});

// The bridge ships to macOS, Linux AND Windows, so both path flavours are exercised here
// whatever machine runs the suite. A display rule only ever tested on one platform is a
// display rule that is wrong on the other two.
test('POSIX: a step shows where a file is, not just its name', () => {
  const P = path.posix;
  assert.equal(displayPath('/w/src/foo.js', '/w', P), 'src/foo.js');
  assert.equal(displayPath('/w/foo.js', '/w', P), 'foo.js');
  assert.equal(displayPath('/w', '/w', P), '.');
  // Outside the working directory keeps its full path — that is the case worth noticing.
  assert.equal(displayPath('/etc/hosts', '/w', P), '/etc/hosts');
  assert.equal(displayPath('/w-other/x.js', '/w', P), '/w-other/x.js', 'a prefix match is not containment');
});

test('Windows: drive letters, backslashes and UNC shares', () => {
  const W = path.win32;
  assert.equal(displayPath('C:\\w\\src\\foo.js', 'C:\\w', W), 'src\\foo.js');
  assert.equal(displayPath('C:\\w', 'C:\\w', W), '.');
  assert.equal(displayPath('C:\\Windows\\system32', 'C:\\w', W), 'C:\\Windows\\system32');
  // The case POSIX does not have: a DIFFERENT ROOT. `relative` returns an absolute path
  // with no `..` in it, so a `..`-only check would silently present another drive as if
  // it were inside the workspace.
  assert.equal(displayPath('D:\\other\\x.js', 'C:\\w', W), 'D:\\other\\x.js');
  assert.equal(displayPath('\\\\server\\share\\x.js', 'C:\\w', W), '\\\\server\\share\\x.js', 'a UNC path is another root too');
});

test('a relative path or a missing cwd is passed through unchanged', () => {
  assert.equal(displayPath('src/a.js', '/w', path.posix), 'src/a.js');
  assert.equal(displayPath('/w/src/a.js', '', path.posix), '/w/src/a.js');
  assert.equal(displayPath('', '/w'), '');
});

test('every engine resolves through the shared helper — no engine keeps its own answer', () => {
  // The bug was five copies drifting apart. A grep is the cheapest guard that they do not
  // drift again, and it fails loudly if someone reintroduces a local default.
  for (const engine of ['claude.js', 'codex.js', 'antigravity.js', 'custom.js']) {
    const src = readFileSync(path.join(ROOT, 'src', 'engines', engine), 'utf8');
    assert.match(src, /resolveWorkdir\(options\.workingDir\)/, `${engine} should use the shared resolver`);
    assert.doesNotMatch(
      src,
      /workingDir \? path\.resolve\(options\.workingDir\) :/,
      `${engine} must not carry its own fallback`,
    );
  }
});

test('the run announces where it will write, before it starts', () => {
  const server = readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  assert.match(server, /type: 'workdir', path: dir, isDefault/, 'a structured event for clients that want it');
  assert.match(server, /Working in \$\{dir\}/, 'and a status line every existing client already renders');
  assert.match(server, /workspace: DEFAULT_WORKSPACE/, '/health should say what a blank field resolves to');
});

test('the sandbox boundary is stated as a DIRECTORY, not a permission', () => {
  // The reported symptom: "auto-edit files is on and it still says it cannot write".
  // Codex's acceptEdits is --sandbox workspace-write, which permits writes only inside the
  // cwd — so the fix is naming the folder, not the setting.
  const note = writeScopeNote('codex', 'acceptEdits', '/home/u/.chatpanel/workspace');
  assert.match(note, /only create or edit files inside \/home\/u\/\.chatpanel\/workspace/);
  assert.match(note, /Working directory/, 'and it must say which control changes it');
});

test('read-only mode says what to turn on, and full access says nothing', () => {
  assert.match(writeScopeNote('codex', 'default', '/w'), /read-only/);
  assert.equal(writeScopeNote('codex', 'bypassPermissions', '/w'), '', 'no boundary, no note');
});

test('engines without a cwd-scoped sandbox get no note', () => {
  // Claude Code's acceptEdits is not directory-confined the same way. Telling every engine
  // the same story would be worse than saying nothing: it would be wrong for most of them.
  for (const engine of ['claude', 'antigravity', 'pi', 'opencode']) {
    assert.equal(writeScopeNote(engine, 'acceptEdits', '/w'), '');
  }
});
