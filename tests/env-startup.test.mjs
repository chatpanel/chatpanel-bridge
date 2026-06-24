import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { agentCandidateBins, agentInstallDirs } from '../src/env.js';

const envJs = readFileSync(new URL('../src/env.js', import.meta.url), 'utf8');

test('PATH discovery never starts an interactive login shell', () => {
  assert.doesNotMatch(envJs, /['"]-ilc['"]/, 'interactive login shells can block daemon startup with prompts');
  assert.match(envJs, /['"]-lc['"]/, 'login shell discovery should stay noninteractive');
});

test('PATH discovery includes OpenCode standalone install directory', () => {
  assert(agentInstallDirs('/Users/tester').includes('/Users/tester/.opencode/bin'));
});

test('agent candidate discovery covers standalone app install layouts', () => {
  assert(agentCandidateBins('opencode', '/Users/tester').includes('/Users/tester/.opencode/bin/opencode'));
  assert(agentCandidateBins('kiro-cli', '/Users/tester').includes('/Applications/Kiro CLI.app/Contents/MacOS/kiro-cli'));
  assert(agentCandidateBins('claude', '/Users/tester').includes('/Users/tester/.local/bin/claude'));
  assert(agentCandidateBins('agy', '/Users/tester').includes('/Users/tester/.local/bin/agy'));
});
