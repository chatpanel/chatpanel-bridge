import assert from 'node:assert/strict';
import test from 'node:test';

import { callLocalMcp } from '../src/mcp-local.js';

test('local MCP process exit includes recent stderr in the error', async () => {
  const script = [
    'process.stdin.resume();',
    'process.stdin.once("data", () => {',
    '  console.error("npm error code E403");',
    '  console.error("npm error 403 registrynpmjsblockpage");',
    '  process.exit(7);',
    '});',
  ].join('');

  await assert.rejects(
    callLocalMcp(
      {
        key: `stderr-test-${Date.now()}-${Math.random()}`,
        command: process.execPath,
        args: ['-e', script],
      },
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    ),
    /local MCP ".+" exited with code 7: npm error code E403\nnpm error 403 registrynpmjsblockpage/,
  );
});
