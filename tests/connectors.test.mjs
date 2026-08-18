// WHAT AN AGENT CAN ALREADY REACH — read from its own config, names only.
//
// A CLI agent brings connectors the extension cannot see. Without the names, the harness can
// only guess at them in a prompt, and an agent that was never told it may use its own tools
// answers a question about an internal thread by telling the user to go and look it up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { connectorsFor } = await import('../src/connectors.js');

test('an unknown agent reports nothing rather than guessing', async () => {
  assert.deepEqual(await connectorsFor('not-an-agent'), []);
  assert.deepEqual(await connectorsFor(''), []);
});

test('codex: [mcp_servers.NAME] tables are read out of config.toml', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cp-codex-'));
  await writeFile(path.join(dir, 'config.toml'), [
    'model = "gpt-5.6-sol"',
    '',
    '[mcp_servers.slack]',
    'command = "npx"',
    'args = ["-y", "@modelcontextprotocol/server-slack"]',
    'env = { SLACK_TOKEN = "xoxb-do-not-leak-this" }',
    '',
    '[mcp_servers.jira-cloud]',
    'command = "jira-mcp"',
  ].join('\n'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    const out = await connectorsFor('codex');
    assert.deepEqual(out, ['jira-cloud', 'slack']);
    // NAMES ONLY. The command, the args and above all the env are what a leak would be made
    // of — none of them may travel with the name.
    const blob = JSON.stringify(out);
    for (const secret of ['xoxb', 'npx', 'command', 'env', 'jira-mcp']) {
      assert.ok(!blob.includes(secret), `"${secret}" travelled with the connector names`);
    }
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test('a missing or malformed config says nothing, and never throws', async () => {
  // A health check the extension needs in order to show the agent AT ALL must not fail
  // because a config file is half-written.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cp-codex-bad-'));
  await writeFile(path.join(dir, 'config.toml'), '[mcp_servers.  \n broken = ');
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    assert.deepEqual(await connectorsFor('codex'), []);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
  process.env.CODEX_HOME = path.join(dir, 'does-not-exist');
  assert.deepEqual(await connectorsFor('codex'), []);
  if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
});

test('the list is deduped, sorted and bounded', async () => {
  // It rides in a health response and then into a system prompt: forty servers should cost a
  // line, not a paragraph. Sorted so it is stable across polls and a settings page does not
  // reorder itself.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cp-codex-many-'));
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(`[mcp_servers.srv-${String(i).padStart(2, '0')}]`);
  rows.push('[mcp_servers.srv-00]');   // a duplicate table name
  await writeFile(path.join(dir, 'config.toml'), rows.join('\n'));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
  try {
    const out = await connectorsFor('codex');
    assert.equal(out.length, 24, 'the list is unbounded');
    assert.deepEqual(out, [...out].sort(), 'the order is not stable');
    assert.equal(new Set(out).size, out.length, 'a duplicate survived');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test('claude: mcpServers keys are read from the home config', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cp-home-'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, '.claude.json'), JSON.stringify({
    mcpServers: { slack: { command: 'x', env: { TOKEN: 'secret' } }, github: { url: 'https://example.com' } },
  }));
  const realHome = os.homedir;
  os.homedir = () => dir;
  try {
    assert.deepEqual(await connectorsFor('claude'), ['github', 'slack']);
  } finally {
    os.homedir = realHome;
  }
});
