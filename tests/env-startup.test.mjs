import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const envJs = readFileSync(new URL('../src/env.js', import.meta.url), 'utf8');

test('PATH discovery never starts an interactive login shell', () => {
  assert.doesNotMatch(envJs, /['"]-ilc['"]/, 'interactive login shells can block daemon startup with prompts');
  assert.match(envJs, /['"]-lc['"]/, 'login shell discovery should stay noninteractive');
});

test('PATH discovery includes OpenCode standalone install directory', () => {
  assert.match(envJs, /\.opencode['"], ['"]bin/, 'OpenCode installs its standalone binary under ~/.opencode/bin');
});
