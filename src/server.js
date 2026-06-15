#!/usr/bin/env node
// ChatPanel Bridge — a tiny localhost server that exposes the coding agents
// running on this machine (Claude Code via the Agent SDK, Codex and Gemini via
// their CLIs) to the ChatPanel Chrome extension. Zero runtime dependencies
// beyond the optional Claude Agent SDK.
//
//   GET  /health  → { ok, version, agents: [{id,label,available,reason}] }
//   POST /chat    → Server-Sent Events stream of { type, ... }:
//                     {type:'delta', text}    incremental assistant text
//                     {type:'tool',  name, summary}
//                     {type:'status'|'reasoning', text?}
//                     {type:'done',  text?}    (text only if not streamed)
//                     {type:'error', error}
//
// Binds to 127.0.0.1 only and accepts requests from the extension origin.

import { createServer } from 'node:http';
import * as claude from './engines/claude.js';
import * as codex from './engines/codex.js';
import * as gemini from './engines/gemini.js';
import { installService, uninstallService, serviceStatus } from './service.js';

const VERSION = '0.2.0';
const HOST = process.env.CHATPANEL_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.CHATPANEL_BRIDGE_PORT) || 4319;

const ENGINES = {
  claude: { engine: claude, label: 'Claude Code' },
  codex: { engine: codex, label: 'Codex' },
  gemini: { engine: gemini, label: 'Gemini CLI' },
};

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
    Object.entries(ENGINES).map(async ([id, { engine, label }]) => {
      const a = await engine.available().catch((e) => ({ ok: false, reason: String(e?.message || e) }));
      return { id, label, available: a.ok, reason: a.reason };
    }),
  );
  json(res, 200, { ok: true, version: VERSION, agents });
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

  try {
    await target.engine.chat(
      {
        messages: Array.isArray(body.messages) ? body.messages : [],
        system: body.system || '',
        options: body.options || {},
      },
      (obj) => {
        if (!closed) emit(obj);
      },
    );
  } catch (e) {
    log('error', `${body.agent} chat failed: ${e?.message || e}`);
    emit({ type: 'error', error: e?.message || String(e) });
  } finally {
    if (!res.writableEnded) res.end();
  }
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
  const prompt = String(body.prompt || '').slice(0, 4000);
  if (!prompt) return json(res, 400, { error: 'Empty prompt' });
  const model = body.model || '';
  const system =
    'You autocomplete a prompt the user is typing to an AI assistant. Continue it ' +
    'briefly — a few words to one short sentence. Reply with ONLY the continuation ' +
    'that comes after their text. No quotes, no repetition.';
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

const server = createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return handleHealth(res);
    if (req.method === 'POST' && url.pathname === '/chat') return handleChat(req, res);
    if (req.method === 'POST' && url.pathname === '/complete') return handleComplete(req, res);
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 500, { error: e?.message || String(e) });
  }
});

function log(level, msg) {
  const fn = level === 'error' ? console.error : console.log;
  fn(`[chatpanel-bridge] ${msg}`);
}

function startServer() {
  server.listen(PORT, HOST, async () => {
    log('info', `listening on http://${HOST}:${PORT}`);
    for (const [, { engine, label }] of Object.entries(ENGINES)) {
      const a = await engine.available().catch(() => ({ ok: false }));
      log('info', `  ${a.ok ? '✓' : '✕'} ${label}${a.ok ? '' : ' — ' + (a.reason || 'unavailable')}`);
    }
    log('info', 'Open the ChatPanel side panel; installed agents (Claude Code, Codex, Gemini CLI) appear automatically.');
  });
}

function printHelp() {
  console.log(`ChatPanel Bridge v${VERSION}

Usage:
  chatpanel-bridge              start the bridge (foreground) on ${HOST}:${PORT}
  chatpanel-bridge --install    run automatically at login, in the background
  chatpanel-bridge --uninstall  remove the login auto-start
  chatpanel-bridge --status     show whether auto-start is set up
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

if (!runCli()) startServer();
