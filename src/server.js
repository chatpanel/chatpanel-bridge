#!/usr/bin/env node
// ChatPanel Bridge — a tiny localhost server that exposes the coding agents
// running on this machine (Claude Code, Codex and Antigravity, each via its CLI) to
// the ChatPanel Chrome extension. Zero runtime dependencies.
//
//   GET  /health  → { ok, version, agents: [...], update: {current,latest,…} }
//   POST /update  → self-update to the latest release (compiled binary installs)
//   POST /chat    → Server-Sent Events stream of { type, ... }:
//                     {type:'delta', text}    incremental assistant text
//                     {type:'tool',  name, summary}
//                     {type:'status'|'reasoning', text?}
//                     {type:'done',  text?}    (text only if not streamed)
//                     {type:'error', error}
//
// Binds to 127.0.0.1 only and accepts requests from the extension origin.

import { createServer } from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import * as claude from './engines/claude.js';
import * as codex from './engines/codex.js';
import * as antigravity from './engines/antigravity.js';
import { pi, opencode, kiro } from './engines/cli-agents.js';
import * as custom from './engines/custom.js';
import { installService, uninstallService, serviceStatus, restartService } from './service.js';
import { enrichPath, findAgentBin, resolveCommand } from './env.js';
import { checkForUpdate, selfUpdate } from './update.js';
import { callLocalMcp } from './mcp-local.js';

// Hardcoded (not read from package.json) so it survives Bun's single-file
// --compile, where package.json isn't on a readable FS. CI fails the publish if
// this drifts from package.json, so the two can't silently diverge.
const VERSION = '0.10.3';
const HOST = process.env.CHATPANEL_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.CHATPANEL_BRIDGE_PORT) || 4319;

const ENGINES = {
  claude: { engine: claude, label: 'Claude Code' },
  codex: { engine: codex, label: 'Codex' },
  antigravity: { engine: antigravity, label: 'Antigravity' },
  pi: { engine: pi, label: 'Pi' },
  opencode: { engine: opencode, label: 'OpenCode' },
  kiro: { engine: kiro, label: 'Kiro' },
  // "Bring your own" — one engine drives any user-onboarded CLI (Pro). Hidden
  // from /health (it's not a single installable agent; the extension manages the
  // list and validates commands via /agent-check).
  custom: { engine: custom, label: 'Custom', hidden: true },
};

// --------------------------------------------------------------------------
// Browser-tools relay. When the extension arms "Act on page" for a CLI agent, it
// sends the tool specs in /chat. We host an HTTP MCP server (/mcp/<session>) the
// CLI connects to; each tools/call is RELAYED to the extension over the chat SSE
// stream (a `tool_request` event), executed there (it owns the browser), and the
// result POSTed back to /tool-result. The bridge itself never touches the page.
// --------------------------------------------------------------------------
const sessions = new Map(); // sessionId -> { id, emit, specs, pending: Map, nextId }
let latestSessionId = null; // for the stable /mcp endpoint (CLIs configured once)

function createSession(emit, specs) {
  const id = randomUUID();
  const s = { id, emit, specs, pending: new Map(), nextId: 0 };
  sessions.set(id, s);
  latestSessionId = id;
  return s;
}

function deleteSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  for (const p of s.pending.values()) p.reject(new Error('chat ended'));
  sessions.delete(id);
  if (latestSessionId === id) {
    // fall back to the most-recently-created surviving session, if any
    const ids = [...sessions.keys()];
    latestSessionId = ids.length ? ids[ids.length - 1] : null;
  }
}

// The session a sessionless /mcp request maps to (CLIs configured once with a
// stable URL — e.g. `opencode mcp add chatpanel --url …/mcp`). The active chat.
function activeSession() {
  return (latestSessionId && sessions.get(latestSessionId)) || null;
}

// Ask the extension to run a tool and await its result. Resolves to MCP content.
function relayToolCall(session, name, input) {
  return new Promise((resolve, reject) => {
    const id = `t${++session.nextId}`;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error('tool call timed out'));
    }, 120_000);
    session.pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(toMcpContent(result)); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    session.emit({ type: 'tool_request', session: session.id, id, name, input });
  });
}

// The extension returns a string OR { text, image(dataURL) }; map to MCP content.
function toMcpContent(result) {
  if (result == null) return { content: [{ type: 'text', text: 'ok' }] };
  if (typeof result === 'string') return { content: [{ type: 'text', text: result }] };
  const content = [];
  if (result.text) content.push({ type: 'text', text: String(result.text) });
  if (typeof result.image === 'string') {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(result.image);
    if (m) content.push({ type: 'image', data: m[2], mimeType: m[1] });
  }
  if (!content.length) content.push({ type: 'text', text: 'ok' });
  return { content };
}

// --------------------------------------------------------------------------
// CORS — allow the extension (chrome-extension://…) and localhost dev origins.
// --------------------------------------------------------------------------
function cors(req, res) {
  const origin = req.headers.origin || '';
  const allow =
    !origin ||
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1');
  res.setHeader('Access-Control-Allow-Origin', allow ? origin || '*' : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 50 * 1024 * 1024) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------
async function handleHealth(res) {
  const agents = await Promise.all(
    Object.entries(ENGINES)
      .filter(([, e]) => !e.hidden)
      .map(async ([id, { engine, label }]) => {
        const a = await engine.available().catch((e) => ({ ok: false, reason: String(e?.message || e) }));
        return { id, label, available: a.ok, reason: a.reason };
      }),
  );
  const update = await checkForUpdate(VERSION).catch(() => ({ current: VERSION, updateAvailable: false }));
  json(res, 200, { ok: true, version: VERSION, agents, update });
}

// POST /update — self-update (compiled-binary installs). Swaps the binary, replies,
// then restarts the service into the new version. npm installs get instructions.
async function handleUpdate(res) {
  try {
    const result = await selfUpdate(VERSION); // throws on npm install / no update / failure
    json(res, 200, { ok: true, updated: true, from: result.from, to: result.to });
    res.on('finish', () => setTimeout(() => restartService(), 400));
  } catch (e) {
    json(res, 400, { ok: false, error: String(e?.message || e) });
  }
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Bad JSON: ' + e.message });
  }
  const target = ENGINES[body.agent];
  if (!target) return json(res, 404, { error: `Unknown agent "${body.agent}"` });
  if (Array.isArray(body.images) && body.images.length) {
    log('info', `chat: ${body.agent} received ${body.images.length} image(s)`);
  }

  // Open the SSE stream.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const emit = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  // If the client disconnects, stop caring about late writes.
  let closed = false;
  req.on('close', () => (closed = true));

  const safeEmit = (obj) => { if (!closed) emit(obj); };

  // Browser-tools relay: when the extension sends page-tool specs, host an MCP
  // server for this turn and tell the engine to point the CLI at it.
  const options = { ...(body.options || {}) };
  let session = null;
  if (body.pageTools?.specs?.length) {
    session = createSession(safeEmit, body.pageTools.specs);
    options.mcp = {
      url: `http://${HOST}:${PORT}/mcp/${session.id}`,
      serverName: 'chatpanel_browser',
      specs: body.pageTools.specs,
    };
  }

  try {
    await target.engine.chat(
      {
        messages: Array.isArray(body.messages) ? body.messages : [],
        system: body.system || '',
        options,
        images: Array.isArray(body.images) ? body.images : [],
      },
      safeEmit,
    );
  } catch (e) {
    log('error', `${body.agent} chat failed: ${e?.message || e}`);
    emit({ type: 'error', error: e?.message || String(e) });
  } finally {
    if (session) deleteSession(session.id);
    if (!res.writableEnded) res.end();
  }
}

// POST /mcp/<session> (per-run, bridge-injected) OR POST /mcp (stable: routes to
// the active chat — for CLIs configured once, e.g. `opencode mcp add … …/mcp`).
// JSON-RPC; tools/call relays to the extension and waits for /tool-result.
async function handleMcp(req, res, sessionId) {
  let msg;
  try {
    msg = await readBody(req);
  } catch {
    return json(res, 200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  // Explicit session id (per-run URL) or the active chat (stable /mcp).
  const session = sessionId ? sessions.get(sessionId) : activeSession();
  const reply = (result) => {
    if (session) res.setHeader('Mcp-Session-Id', session.id);
    json(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, result });
  };
  const fail = (code, message) => json(res, 200, { jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });

  // Notifications (no id) — ack and ignore.
  if (msg.id == null) { res.writeHead(202); return res.end(); }

  if (msg.method === 'initialize') {
    return reply({
      protocolVersion: msg.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'chatpanel-browser', version: VERSION },
    });
  }
  // No active chat → advertise zero tools rather than erroring, so a CLI with a
  // standing /mcp config (run outside ChatPanel) starts cleanly instead of failing.
  if (!session) {
    if (msg.method === 'tools/list') return reply({ tools: [] });
    return fail(-32001, 'No active ChatPanel session — open a chat with “Act on page” on.');
  }
  if (msg.method === 'tools/list') {
    return reply({
      tools: session.specs.map((s) => ({
        name: s.name,
        description: s.description,
        inputSchema: s.parameters || { type: 'object', properties: {} },
      })),
    });
  }
  if (msg.method === 'tools/call') {
    try {
      return reply(await relayToolCall(session, msg.params?.name, msg.params?.arguments || {}));
    } catch (e) {
      return reply({ content: [{ type: 'text', text: `error: ${e?.message || e}` }], isError: true });
    }
  }
  return fail(-32601, `Method not found: ${msg.method}`);
}

// POST /mcp-local — proxy one JSON-RPC message to a user-configured STDIO MCP
// server that the bridge spawns and keeps alive. Body: { server:{id,command,args,
// env?,cwd?}, message }. Returns the full JSON-RPC response (or 202 for a
// notification). Lets the extension use local MCP servers it can't spawn itself.
async function handleMcpLocal(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Bad JSON: ' + e.message });
  }
  const server = body.server || {};
  const message = body.message;
  if (!server.command || !message) return json(res, 400, { error: 'need server.command and message' });
  try {
    const result = await callLocalMcp(
      { key: server.id, command: server.command, args: server.args, env: server.env, cwd: server.cwd },
      message,
    );
    if (message.id == null) { res.writeHead(202); return res.end(); }
    return json(res, 200, result); // the full JSON-RPC response message
  } catch (e) {
    return json(res, 200, {
      jsonrpc: '2.0',
      id: message.id ?? null,
      error: { code: -32000, message: String(e?.message || e) },
    });
  }
}

// POST /tool-result — the extension returns a relayed tool's result.
async function handleToolResult(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Bad JSON: ' + e.message });
  }
  const session = sessions.get(body.session);
  if (!session) return json(res, 404, { error: 'no such session' });
  const pending = session.pending.get(body.id);
  if (!pending) return json(res, 404, { error: 'no such pending call' });
  session.pending.delete(body.id);
  pending.resolve(body.result);
  return json(res, 200, { ok: true });
}

// POST /complete → { agent, prompt, model? } → { text } — a fast, single-shot
// completion for prompt autocomplete. Uses the engine's complete() if it has one
// (Claude: Haiku, no tools), else a one-shot chat collected into text.
async function handleComplete(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Bad JSON: ' + e.message });
  }
  const target = ENGINES[body.agent];
  if (!target) return json(res, 404, { error: `Unknown agent "${body.agent}"` });
  const prompt = String(body.prompt || '').slice(0, 6000);
  if (!prompt) return json(res, 400, { error: 'Empty prompt' });
  const model = body.model || '';
  // The extension sends a strict "continue, don't answer" system prompt (with any
  // page context already in `prompt`); fall back to a sensible default.
  const system =
    String(body.system || '').slice(0, 2000) ||
    'You autocomplete an unfinished message the user is typing. Output ONLY the ' +
      'few words that come next. Do not answer it. No quotes, no repetition.';
  try {
    let text = '';
    if (typeof target.engine.complete === 'function') {
      text = await target.engine.complete({ prompt, system, model });
    } else {
      await target.engine.chat(
        { messages: [{ role: 'user', content: prompt }], system, options: { model } },
        (obj) => {
          if (obj.type === 'delta') text += obj.text || '';
          else if (obj.type === 'done' && obj.text) text += obj.text;
        },
      );
    }
    return json(res, 200, { text: (text || '').trim() });
  } catch (e) {
    return json(res, 502, { error: e?.message || String(e) });
  }
}

// POST /list-models → { agent, options } → { models } — the unified model-list
// interface. Each engine decides HOW to enumerate (claude → known aliases; custom
// → runs the agent's configured `listModelsArgs`, e.g. pi `--list-models` /
// opencode `models`, and parses stdout). Engines without a lister return [].
async function handleListModels(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Bad JSON: ' + e.message });
  }
  const target = ENGINES[body.agent];
  if (!target) return json(res, 404, { error: `Unknown agent "${body.agent}"` });
  if (typeof target.engine.listModels !== 'function') return json(res, 200, { models: [] });
  try {
    const models = await target.engine.listModels(body.options || {});
    return json(res, 200, { models: Array.isArray(models) ? models : [] });
  } catch (e) {
    return json(res, 502, { error: e?.message || String(e) });
  }
}

// POST /agent-check → { command } → { ok, via } — does this command resolve on
// this machine? Powers the "✓ found" indicator when onboarding a custom agent.
// `via` tells the user HOW it resolved (native / script / cmd / wsl) so a Windows
// user sees e.g. "found in WSL". No execution, no entitlement needed (read-only).
async function handleAgentCheck(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Bad JSON: ' + e.message });
  }
  const command = String(body.command || '').trim();
  if (!command) return json(res, 400, { error: 'No command' });
  let spec = null;
  try {
    spec = resolveCommand(command);
  } catch {
    spec = null;
  }
  return json(res, 200, { ok: !!spec, via: spec ? spec.kind : null });
}

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return handleHealth(res);
    if (req.method === 'GET' && url.pathname === '/debug') {
      return json(res, 200, {
        version: VERSION,
        home: os.homedir(),
        codex: findAgentBin('codex') || null,
        agy: findAgentBin('agy') || null,
        path: process.env.PATH,
      });
    }
    if (req.method === 'POST' && url.pathname === '/chat') return handleChat(req, res);
    // Stable endpoint: routes to the active chat. For CLIs configured once with a
    // fixed URL (e.g. `opencode mcp add chatpanel --url http://127.0.0.1:4319/mcp`).
    if (url.pathname === '/mcp') {
      if (req.method === 'POST') return handleMcp(req, res, null);
      if (req.method === 'GET') { res.writeHead(405); return res.end(); }
    }
    if (url.pathname.startsWith('/mcp/')) {
      const sid = decodeURIComponent(url.pathname.slice(5));
      if (req.method === 'POST') return handleMcp(req, res, sid);
      if (req.method === 'GET') { res.writeHead(405); return res.end(); } // no server-initiated stream
      if (req.method === 'DELETE') { deleteSession(sid); res.writeHead(204); return res.end(); }
    }
    if (req.method === 'POST' && url.pathname === '/tool-result') return handleToolResult(req, res);
    if (req.method === 'POST' && url.pathname === '/mcp-local') return handleMcpLocal(req, res);
    if (req.method === 'POST' && url.pathname === '/complete') return handleComplete(req, res);
    if (req.method === 'POST' && url.pathname === '/list-models') return handleListModels(req, res);
    if (req.method === 'POST' && url.pathname === '/agent-check') return handleAgentCheck(req, res);
    if (req.method === 'POST' && url.pathname === '/update') return handleUpdate(res);
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: e?.message || String(e) });
  }
});

function log(level, msg) {
  const fn = level === 'error' ? console.error : console.log;
  fn(`[chatpanel-bridge] ${msg}`);
}

// `--mcp-stdio <url>` — run as a stdio↔HTTP MCP proxy: read newline-delimited
// JSON-RPC from stdin, forward each message to the bridge's HTTP MCP endpoint
// (<url> = http://127.0.0.1:PORT/mcp/<session>), and write responses to stdout.
// This lets ANY stdio-MCP CLI (Codex, a custom CLI) use the browser tools with
// the bridge binary itself as the MCP server command — no extra runtime needed.
function runMcpStdioProxy(url) {
  let buf = '';
  const queue = [];
  let draining = false;
  let ended = false;
  const maybeExit = () => { if (ended && !draining && !queue.length) process.exit(0); };
  const drain = async () => {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const line = queue.shift();
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: line,
        });
        if (msg.id == null) continue; // notification — no response expected
        const text = (await res.text()).trim();
        if (text) process.stdout.write(text + '\n');
      } catch (e) {
        if (msg.id != null) {
          process.stdout.write(
            JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(e?.message || e) } }) + '\n',
          );
        }
      }
    }
    draining = false;
    maybeExit(); // stdin closed mid-flight → exit only after the queue is drained
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) queue.push(line);
    }
    drain();
  });
  process.stdin.on('end', () => { ended = true; maybeExit(); });
  process.stdin.resume();
}

function startServer() {
  enrichPath(); // so codex/gemini are found even under a minimal service PATH
  server.listen(PORT, HOST, async () => {
    log('info', `listening on http://${HOST}:${PORT}`);
    for (const [, { engine, label, hidden }] of Object.entries(ENGINES)) {
      if (hidden) continue;
      const a = await engine.available().catch(() => ({ ok: false }));
      log('info', `  ${a.ok ? '✓' : '✕'} ${label}${a.ok ? '' : ' — ' + (a.reason || 'unavailable')}`);
    }
    log('info', 'Open the ChatPanel side panel; installed agents (Claude Code, Codex, Antigravity) appear automatically.');
  });
}

function printHelp() {
  console.log(`ChatPanel Bridge v${VERSION}

Usage:
  chatpanel-bridge              start the bridge (foreground) on ${HOST}:${PORT}
  chatpanel-bridge --install    run automatically at login, in the background
  chatpanel-bridge --uninstall  remove the login auto-start
  chatpanel-bridge --status     show whether auto-start is set up
  chatpanel-bridge --update     download & install the latest version, then restart
  chatpanel-bridge --version    print the version

Env: CHATPANEL_BRIDGE_HOST, CHATPANEL_BRIDGE_PORT`);
}

// Handle CLI commands before starting the server. Returns true if a command ran.
function runCli() {
  const argv = process.argv;
  const has = (...flags) => flags.some((f) => argv.includes(f));

  if (has('--help', '-h')) {
    printHelp();
    return true;
  }
  if (has('--version', '-v')) {
    console.log(VERSION);
    return true;
  }
  if (has('--install')) {
    try {
      installService();
      log('info', 'Installed. The bridge now starts automatically at login and is running in the background.');
    } catch (e) {
      log('error', 'Install failed: ' + (e?.message || e));
      process.exitCode = 1;
    }
    return true;
  }
  if (has('--uninstall')) {
    try {
      uninstallService();
      log('info', 'Removed the login auto-start.');
    } catch (e) {
      log('error', 'Uninstall failed: ' + (e?.message || e));
      process.exitCode = 1;
    }
    return true;
  }
  if (has('--status')) {
    let on = false;
    try {
      on = serviceStatus();
    } catch (e) {
      log('error', String(e?.message || e));
    }
    log('info', `auto-start: ${on ? 'installed' : 'not installed'}`);
    return true;
  }
  return false;
}

const mcpStdioIdx = process.argv.indexOf('--mcp-stdio');
if (mcpStdioIdx >= 0) {
  const url = process.argv[mcpStdioIdx + 1];
  if (!url) {
    console.error('--mcp-stdio requires a URL');
    process.exit(1);
  }
  runMcpStdioProxy(url);
} else if (process.argv.includes('--update')) {
  (async () => {
    try {
      const r = await selfUpdate(VERSION);
      log('info', `Updated v${r.from} → v${r.to}. Restarting the background service…`);
      restartService();
    } catch (e) {
      log('error', 'Update failed: ' + (e?.message || e));
      process.exitCode = 1;
    }
  })();
} else if (!runCli()) {
  startServer();
}
