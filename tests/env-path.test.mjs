// FINDING THE CLI THE USER ACTUALLY HAS — without an interactive shell.
//
// Under a LaunchAgent the bridge starts with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so
// enrichPath() asks the login shell. But `-lc` reads .zprofile and NOT .zshrc, and .zshrc is
// where nvm installs itself. The answer therefore arrives as "the user's PATH minus their
// version manager", while still carrying /opt/homebrew/bin from .zprofile — so a Homebrew
// copy of an agent CLI beat the one the terminal runs.
//
// One machine had Claude Code 2.1.268 under nvm and 2.1.175 under Homebrew, and every turn
// through the bridge answered "Claude Code 2.1.175 does not support this model" to a user
// who had just updated it.
//
// The shell stays NON-INTERACTIVE — tests/env-startup.test.mjs holds that line, because an
// interactive shell can block a daemon's startup on a prompt. So the version manager is put
// back by reading the filesystem instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nvmCurrentBin } from '../src/env.js';

function fakeNvm(versions, defaultAlias = null) {
  const home = mkdtempSync(join(tmpdir(), 'cp-nvm-'));
  const root = join(home, '.nvm', 'versions', 'node');
  for (const v of versions) mkdirSync(join(root, v, 'bin'), { recursive: true });
  if (defaultAlias !== null) {
    mkdirSync(join(home, '.nvm', 'alias'), { recursive: true });
    writeFileSync(join(home, '.nvm', 'alias', 'default'), defaultAlias);
  }
  return { home, root, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('the `default` alias wins — it is what a new shell resolves to', () => {
  const { home, root, cleanup } = fakeNvm(['v18.20.4', 'v20.11.0', 'v24.14.0'], '20.11.0');
  try {
    assert.equal(nvmCurrentBin(home, {}), join(root, 'v20.11.0', 'bin'));
  } finally { cleanup(); }
});

test('an alias written with a leading v works too', () => {
  const { home, root, cleanup } = fakeNvm(['v18.20.4', 'v24.14.0'], 'v18.20.4');
  try {
    assert.equal(nvmCurrentBin(home, {}), join(root, 'v18.20.4', 'bin'));
  } finally { cleanup(); }
});

test('with no alias it is the HIGHEST installed, compared numerically', () => {
  // Directory order is alphabetical, which puts v9 after v10 — so this cannot be a sort of
  // strings, and enumerating "every installed version" (what versionManagerBins does) would
  // pick an arbitrary one.
  const { home, root, cleanup } = fakeNvm(['v9.11.2', 'v10.24.1', 'v24.14.0']);
  try {
    assert.equal(nvmCurrentBin(home, {}), join(root, 'v24.14.0', 'bin'));
  } finally { cleanup(); }
});

test('an alias naming a version that is NOT installed falls back rather than pointing at nothing', () => {
  const { home, root, cleanup } = fakeNvm(['v24.14.0'], 'lts/*');
  try {
    // `lts/*` is an alias chain we deliberately do not chase: the highest installed is a
    // better answer than a directory that does not exist.
    assert.equal(nvmCurrentBin(home, {}), join(root, 'v24.14.0', 'bin'));
  } finally { cleanup(); }
});

test('no nvm is not an error — most machines do not have one', () => {
  const home = mkdtempSync(join(tmpdir(), 'cp-nonvm-'));
  try {
    assert.equal(nvmCurrentBin(home, {}), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('NVM_DIR is honoured, because nvm can live anywhere', () => {
  const { home, cleanup } = fakeNvm(['v24.14.0']);
  try {
    assert.equal(
      nvmCurrentBin('/nowhere', { NVM_DIR: join(home, '.nvm') }),
      join(home, '.nvm', 'versions', 'node', 'v24.14.0', 'bin'),
    );
  } finally { cleanup(); }
});
