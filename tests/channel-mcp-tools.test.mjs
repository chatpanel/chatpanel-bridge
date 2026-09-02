// A phone that cannot read your history is not "texting your machine", and a phone that can
// rewrite your memory is not "read-only". Both halves are asserted here.
//
// THE BUG THIS PREVENTS. The reach cap was written against Claude Code's BUILT-IN tools, so a
// capped turn got --allowedTools Read,Grep,Glob,... and nothing else. ChatPanel's own history
// tools arrive as a user-configured MCP server, so they were outside that list, and a headless
// run has nobody to approve them: the phone was told "the search tools need your permission and
// it hasn't been granted yet" — the one question this product cannot ask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { channelMcpTools, channelToolPolicy } from '../src/engines/claude.js';

const CONNECTORS = ['chatpanel', 'chatpanel-history', 'jira', 'sharepoint', 'node_repl'];

test('a trusted phone may read the history it was installed to reach', () => {
  const { allow } = channelMcpTools('trusted', CONNECTORS);
  for (const tool of ['search_history', 'smart_search', 'get_record', 'recall', 'find_related']) {
    assert.ok(allow.includes(`mcp__chatpanel__${tool}`), `${tool} must be pre-approved for a trusted phone`);
  }
  assert.ok(allow.includes('mcp__chatpanel-history__smart_search'), 'every ChatPanel server the user configured, under the name they gave it');
});

test('it may not rewrite what the assistant remembers', () => {
  const { allow, deny } = channelMcpTools('trusted', CONNECTORS);
  for (const tool of ['remember', 'forget']) {
    assert.ok(!allow.some((t) => t.endsWith(`__${tool}`)), `${tool} mutates — never on a capped tier`);
    assert.ok(deny.includes(`mcp__chatpanel__${tool}`), `${tool} must be denied explicitly, not merely omitted`);
  }
});

test('a stranger\'s MCP server is not swept in', () => {
  const { allow, deny } = channelMcpTools('trusted', CONNECTORS);
  for (const name of ['jira', 'sharepoint', 'node_repl']) {
    assert.ok(!allow.some((t) => t.includes(name)), `${name} is not ChatPanel's to grant`);
    assert.ok(!deny.some((t) => t.includes(name)), `${name} is not ChatPanel's to speak about at all`);
  }
});

test('device reach stays conversational — reads are a trusted-tier grant', () => {
  const { allow, deny } = channelMcpTools('device', CONNECTORS);
  assert.deepEqual(allow, [], 'no history for a device-tier phone');
  assert.ok(deny.includes('mcp__chatpanel__remember'), 'but the write denial still applies');
});

test('an unknown tier fails closed, like the built-in policy does', () => {
  assert.deepEqual(channelMcpTools('wide-open', CONNECTORS).allow, [], 'an unrecognised tier gets nothing');
  assert.deepEqual(channelToolPolicy('wide-open').allow, ['TodoWrite', 'Task'], 'and the built-in cap agrees');
});

test('egress stays cut, which is what makes reading safe', () => {
  const { deny } = channelToolPolicy('trusted');
  for (const tool of ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch']) {
    assert.ok(deny.includes(tool), `${tool} must stay denied — reading is only safe while nothing can leave`);
  }
});
