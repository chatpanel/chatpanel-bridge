// A CLI agent's own MCP servers failing auth is a common, fixable failure — and its output is
// an HTML error page. Surfacing that raw put kilobytes of markup and an SVG logo in the chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCliError, stripMarkup } from '../src/cli-errors.js';

const HTML_403 = `ERROR transport: worker quit with fatal: Transport channel closed, when UnexpectedServerResponse("HTTP 403: <!DOCTYPE html>
<html><head><style>body { font-family: 'Roboto'; background-color: #f4f4f4; }</style></head>
<body><svg width="231" height="30"><path d="M99.61,19.52h15.24l-8.05-13L92,30H85.27"/></svg>
<h1>Technical Difficulties</h1><p>This site is experiencing a technical difficulty.</p></body></html>")`;

test('an HTML error page never reaches the user', () => {
  const out = summarizeCliError('Codex', 1, HTML_403);
  assert.ok(!/<|\{|font-family|svg|path d=/i.test(out), `markup leaked: ${out}`);
  assert.ok(out.length < 300, 'stays short');
  assert.match(out, /403/, 'but keeps the fact that matters');
  assert.match(out, /outside ChatPanel|temporarily down/i, 'and says whose problem it is');
});

test('an expired OAuth token names the server and the fix', () => {
  const out = summarizeCliError('Codex', 1,
    'ERROR oauth::refresh: error=failed to refresh OAuth tokens for server acme_wiki: OAuth refresh token was rejected: invalid_grant: refresh token does not exist');
  assert.match(out, /acme_wiki/, 'names the server that failed');
  assert.match(out, /re-authenticat/i, 'and the action that fixes it');
  assert.ok(!/ChatPanel can.t refresh it\.\s*$/.test(out) === false || out.includes("ChatPanel can't refresh it"), 'is clear it is not ChatPanel to fix');
});

test('a 401 is distinguished from an expired refresh token', () => {
  const out = summarizeCliError('Codex', 1, 'AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\\"invalid_token\\"" })');
  assert.match(out, /401|invalid_token/i);
  assert.match(out, /Re-authenticate/i);
});

test('an ordinary failure still surfaces its real last error line', () => {
  const out = summarizeCliError('Claude Code', 2, 'warming up\nsomething benign\nError: model refused the request');
  assert.match(out, /model refused the request/);
});

test('stripMarkup removes style, script and svg wholesale', () => {
  const s = stripMarkup('<style>a{b:c}</style><script>x()</script><svg><path/></svg>hello');
  assert.ok(!/a\{b:c\}|x\(\)|path/.test(s));
  assert.match(s, /hello/);
});
