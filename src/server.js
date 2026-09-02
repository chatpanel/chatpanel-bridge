#!/usr/bin/env node
// ChatPanel Bridge — a tiny localhost server that exposes the coding agents
// running on this machine (Claude Code, Codex and Antigravity, each via its CLI) to
// the ChatPanel Chrome extension. Zero runtime dependencies.
//
//   GET  /health  → { ok, version, agents: [{id,label,available,reason,connectors}], update }
//   POST /update  → self-update to the latest release (compiled binary installs)
//   POST /chat    → Server-Sent Events stream of { type, ... }:
//                     {type:'delta', text}    incremental assistant text
//                     {type:'tool',  name, summary}
//                     {type:'status'|'reasoning', text?}
//                     {type:'workdir', path, isDefault}  where this run writes
//                     {type:'done',  text?}    (text only if not streamed)
//                     {type:'error', error}
//   POST /v1/chat/completions, /v1/completions, /v1/responses
//                 → OpenAI-compatible text adapters for the local agents
//   POST /v1/messages → Anthropic-compatible text adapter for the local agents
//   GET  /skills              → skill packages on disk (name + description + files)
//   GET  /skills/<name>       → one skill, SKILL.md body included
//   GET  /skills/<name>/file/<path> → one reference/template/asset from that package
//
// Binds to 127.0.0.1 only. A request guard (see `guard()`) enforces a loopback
// Host (anti DNS-rebinding) and an allowlisted Origin; the command-spawning
// endpoints (/chat, /mcp-local, /update, …) additionally require the extension
// origin or the per-install bridge token, so a malicious web page can't drive
// local execution. The CLI-facing /mcp endpoints stay open to no-Origin clients.

import { createServer } from 'node:http';
import os from 'node:os';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as claude from './engines/claude.js';
import * as codex from './engines/codex.js';
import * as antigravity from './engines/antigravity.js';
import { pi, opencode, kiro, copilot, deepseek , hermes } from './engines/cli-agents.js';
import { connectorsFor } from './connectors.js';
import * as custom from './engines/custom.js';
import { installService, uninstallService, serviceStatus, restartService } from './service.js';
import { skillIndex, listRecords, readRecord, readPackageFile, skillsHealth, quarantinedSkills } from './skills.js';
import { capabilityToolSpecs, runCapabilityTool } from './mcp-capabilities.js';
import { DEFAULT_WORKSPACE, isDefaultWorkdir, resolveWorkdir, writeScopeNote } from './workdir.js';
import { AGENT_CLIS, enrichPath, enrichAgentEnv, findAgentBin, resolveCommand } from './env.js';
import { stripHidden } from './sanitize.js';
import { checkForUpdate, selfUpdate } from './update.js';
import { callLocalMcp } from './mcp-local.js';
import { assertPublicHttpUrl, assertPublicWebUrl } from './ssrf.js';
import { startRun, endRun, cancelRun, cancelAll, activeRuns } from './runs.js';
import {
  CompatError,
  anthropicError,
  anthropicStream,
  chatCompletionStream,
  completionStream,
  createAnthropicMessage,
  createChatCompletion,
  createCompletion,
  createResponse,
  openAIError,
  parseAnthropicMessage,
  parseChatCompletion,
  parseCompletion,
  parseResponse,
  responseStream,
} from './api-compat.js';

// Hardcoded (not read from package.json) so it survives Bun's single-file
// --compile, where package.json isn't on a readable FS. CI fails the publish if
// this drifts from package.json, so the two can't silently diverge.
const VERSION = '0.11.7';
const HOST = process.env.CHATPANEL_BRIDGE_HOST || '127.0.0.1';
const PORT = Number(process.env.CHATPANEL_BRIDGE_PORT) || 4319;

const ENGINES = {
  claude: { engine: claude, label: 'Claude Code' },
  codex: { engine: codex, label: 'Codex' },
  antigravity: { engine: antigravity, label: 'Antigravity' },
  pi: { engine: pi, label: 'Pi' },
  opencode: { engine: opencode, label: 'OpenCode' },
  hermes: { engine: hermes, label: 'Hermes' },
  kiro: { engine: kiro, label: 'Kiro' },
  copilot: { engine: copilot, label: 'GitHub Copilot' },
  deepseek: { engine: deepseek, label: 'DeepSeek Harness' },
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
  // L5: de-steganographize tool-result TEXT before it flows back to the CLI/model —
  // the bridge is a public localhost endpoint, so (like the prompt path) it must strip
  // ASCII-smuggled / bidi Unicode from relayed results, not assume the caller did.
  if (result == null) return { content: [{ type: 'text', text: 'ok' }] };
  if (typeof result === 'string') return { content: [{ type: 'text', text: stripHidden(result) }] };
  const content = [];
  if (result.text) content.push({ type: 'text', text: stripHidden(String(result.text)) });
  if (typeof result.image === 'string') {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(result.image);
    if (m) content.push({ type: 'image', data: m[2], mimeType: m[1] });
  }
  if (!content.length) content.push({ type: 'text', text: 'ok' });
  return { content };
}

// --------------------------------------------------------------------------
// CORS — allow the extension (chrome-extension://…) and localhost dev origins.
// NOTE: CORS only controls whether a *page* may READ the response; it does NOT
// stop a cross-origin request from running. The hard allow/deny gating that
// actually protects the command-spawning endpoints lives in `guard()` below.
// --------------------------------------------------------------------------
function originAllowed(origin) {
  return (
    !origin ||
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.startsWith('http://[::1]')
  );
}

// An origin that identifies the ChatPanel extension (or a local dev build).
// Distinct from originAllowed(): this REQUIRES the header to be present, so a
// no-Origin local process cannot pose as the extension on privileged routes.
function isExtensionOrigin(origin) {
  return (
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    origin.startsWith('http://localhost') ||
    origin.startsWith('http://127.0.0.1') ||
    origin.startsWith('http://[::1]')
  );
}

function cors(req, res) {
  const origin = req.headers.origin || '';
  const allow = originAllowed(origin);
  res.setHeader('Access-Control-Allow-Origin', allow ? origin || '*' : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key, Anthropic-Version, X-ChatPanel-Token');
  res.setHeader('Vary', 'Origin');
}

// --------------------------------------------------------------------------
// Security gates — defend the localhost server against a malicious web page.
//
// Two browser attack classes are in scope even though we bind to 127.0.0.1:
//   1. DNS rebinding — a page on http://evil.example rebinds that name to
//      127.0.0.1 and fetches http://evil.example:PORT/…; the request arrives
//      with Host: evil.example, which a naïve server happily serves.
//   2. Cross-origin CSRF — a page POSTs a CORS "simple" request (text/plain)
//      to http://127.0.0.1:PORT/…; no preflight fires and the side effect runs.
//
// hostAllowed() closes (1) by rejecting any non-loopback Host. The Origin
// checks close (2). Privileged endpoints additionally require the extension
// origin or the per-install token, so a no-Origin local process can't drive
// command execution either.
// --------------------------------------------------------------------------
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1']);

function hostAllowed(req) {
  // If the operator deliberately bound to a non-loopback/all interface
  // (CHATPANEL_BRIDGE_HOST=0.0.0.0 / a LAN IP), don't second-guess their Host.
  if (!LOOPBACK_HOSTNAMES.has(HOST)) return true;
  const raw = String(req.headers.host || '');
  if (!raw) return false; // HTTP/1.1 requires Host; absent → reject
  const hostname = raw
    .replace(/:\d+$/, '') // strip :port
    .replace(/^\[|\]$/g, '') // strip IPv6 brackets
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname);
}

// Per-install bearer token — defense-in-depth so a non-browser local client can
// authenticate to privileged routes without relying on an Origin header. Written
// 0600 to ~/.chatpanel/bridge-token; the extension is allowed by origin and need
// not send it, so adding this never breaks the existing wire contract.
const TOKEN_PATH = join(os.homedir(), '.chatpanel', 'bridge-token');
let AUTH_TOKEN = '';
function ensureToken() {
  try {
    if (existsSync(TOKEN_PATH)) AUTH_TOKEN = readFileSync(TOKEN_PATH, 'utf8').trim();
    if (!AUTH_TOKEN) {
      AUTH_TOKEN = randomBytes(32).toString('hex');
      mkdirSync(join(os.homedir(), '.chatpanel'), { recursive: true });
      writeFileSync(TOKEN_PATH, AUTH_TOKEN, { mode: 0o600 });
    }
  } catch (e) {
    // Token is optional hardening — never fail startup over it.
    log('error', `could not initialise bridge token: ${e?.message || e}`);
  }
}
// ---------------------------------------------------------------------------
// CHANNELS — a messaging surface (Telegram today) driving a local agent.
//
// Hosted HERE because a channel has to be running when nobody is looking: the point is to
// reach your machine from a phone with the browser closed, and the bridge is the only
// always-on local process a ChatPanel user already has. The alternative — a second daemon, or
// an npm install, or a service worker Chrome suspends — is another thing a non-technical
// person has to install and keep alive, which is the same as not shipping it.
//
// The bridge owns transport and auth; @chatpanel/channels (vendored to src/channels) owns the
// contract: verify a bot, hold its token 0600, enroll a phone by one-time code, cap it with
// `reach`, redact both ways. Loaded lazily so the redaction engine never touches a boot where
// no channel is configured.
let channelsSvc = null;
async function channelService() {
  if (channelsSvc) return channelsSvc;
  const { createChannelService } = await import('./channels/service.js');
  channelsSvc = createChannelService({
    home: join(os.homedir(), '.chatpanel'),
    dataDir: join(os.homedir(), '.chatpanel', 'channels'),
    // It talks to THIS bridge as a privileged local client — same port, same token it just
    // read. No second address to configure and get wrong.
    bridge: { baseUrl: `http://127.0.0.1:${PORT}`, token: AUTH_TOKEN },
    logger: { log: (m) => log('info', m), warn: (m) => log('info', m), error: (m) => log('error', m) },
  });
  return channelsSvc;
}

async function handleChannels(req, res, action) {
  try {
    const svc = await channelService();
    const body = req.method === 'POST' ? await readBody(req) : {};
    if (action === 'status') return json(res, 200, await svc.status());
    if (action === 'connect') {
      // The token is verified with Telegram before it is written, so a typo fails HERE, in the
      // settings screen, with a reason — not later as a silent poll loop nobody reads the logs of.
      const r = await svc.connect(body);
      return json(res, 200, { ok: true, ...r });
    }
    if (action === 'pair') return json(res, 200, await svc.pair());
    if (action === 'unpair') return json(res, 200, await svc.unpair(String(body.actorId || '')));
    if (action === 'settings') return json(res, 200, await svc.update(body));
    if (action === 'disconnect') return json(res, 200, await svc.stop({ forget: !!body.forget }));
    return json(res, 404, { error: 'unknown channel action' });
  } catch (e) {
    // A readable reason, because every one of these is something a person can fix: a bad token,
    // a bot not created yet, no network.
    return json(res, 400, { error: e?.message || String(e) });
  }
}

function tokenOk(req) {
  if (!AUTH_TOKEN) return false;
  const h = String(req.headers['authorization'] || '');
  const provided = (h.startsWith('Bearer ')
    ? h.slice(7)
    : String(req.headers['x-api-key'] || req.headers['x-chatpanel-token'] || '')).trim();
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// POST sinks that spawn local agents/commands or self-update, plus GET /debug
// (leaks PATH/home). Only the extension (allowlisted origin) or a token-bearing
// client may reach these. The CLI-facing /mcp and /mcp/<id> routes are NOT here:
// local coding-agent CLIs connect to them with no Origin header by design.
const PRIVILEGED_POST = new Set([
  '/chat',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/responses',
  '/v1/messages',
  '/mcp-local',
  '/mcp-remote',
  '/fetch-title',
  '/complete',
  '/list-models',
  '/agent-check',
  '/update',
  '/tool-result',
  // Cancelling someone else's run is a denial of service, small but real — and every other
  // endpoint that touches a run is already guarded. An unauthenticated hole next to nine
  // guarded neighbours is a hole regardless of how little it grants.
  '/cancel',
  // A channel is a way into this machine from the internet. Everything that configures one —
  // and the code that enrolls a phone — is as privileged as /chat itself.
  '/channels/connect',
  '/channels/pair',
  '/channels/unpair',
  '/channels/settings',
  '/channels/disconnect',
]);
// /channels is NOT here, for the same reason /skills is not, and it was a regression to add
// it: a privileged GET is unreachable from the extension. The panel holds `<all_urls>`, so
// its fetches bypass CORS altogether — no preflight fires — and the Fetch spec attaches
// `Origin` only to requests whose method is not GET or HEAD. That is the whole asymmetry:
// every privileged POST here works, and a privileged GET can only ever answer the settings
// page with "forbidden: this endpoint requires the ChatPanel extension or a valid bridge
// token", which is what shipped in 0.11.0.
//
// Nothing is opened up by removing it. `originAllowed` still refuses any web page (it is the
// check doing the work), so the only caller admitted is a local no-Origin process — which can
// already read ~/.chatpanel/channels/ off the disk. /debug stays privileged: it exposes
// configuration a local process cannot otherwise see.
const PRIVILEGED_GET = new Set(['/debug']);

// /skills* is NOT privileged, and that is a considered position rather than a
// convenience. `privileged` adds exactly one thing over the origin allowlist: it requires
// the Origin header to be PRESENT, so a no-Origin local process cannot pose as the
// extension. Work through who that actually excludes for a read-only listing of files:
//
//   • a web page — always sends Origin, and a non-allowed one is already refused above;
//   • a page on http://localhost — sends Origin, which `isExtensionOrigin` already
//     accepts, so the privileged check never stopped it either way;
//   • a page using <img>/<script> to force a no-Origin GET — cannot read the response,
//     because it is JSON with no CORS grant to that origin;
//   • remote SSRF into 127.0.0.1 — arrives with a non-loopback Host and dies at
//     `hostAllowed` long before this;
//   • a local process — the only caller left, and it can read the very same SKILL.md
//     files straight off the disk.
//
// So the requirement excluded nothing that could not already read the bytes, while
// breaking the one client that should have them: Chrome omits Origin on a simple GET from
// an extension page (the POST routes get it only because a JSON body forces a preflight).
// The origin allowlist stays and is what keeps web pages out. /debug remains privileged —
// it exposes configuration a local process cannot otherwise see.
const isPrivilegedGetPath = (p) => PRIVILEGED_GET.has(p);

// SSRF guard for /mcp-remote lives in ./ssrf.js (assertPublicHttpUrl). Loopback
// is allowed (the user's own localhost MCP server — the common "via bridge"
// case; the extension can reach it directly anyway), cloud metadata is always
// blocked, and other private/LAN ranges are blocked unless the operator sets
// CHATPANEL_BRIDGE_ALLOW_PRIVATE_HOSTS=1. Checked on the initial URL AND after
// any redirect.

// Returns an error code if the request must be blocked, else null.
function guard(req, pathname) {
  if (!hostAllowed(req)) return 'forbidden host';
  const origin = req.headers.origin || '';
  if (origin && !originAllowed(origin)) return 'forbidden origin';
  const privileged =
    (req.method === 'POST' && PRIVILEGED_POST.has(pathname)) ||
    (req.method === 'GET' && isPrivilegedGetPath(pathname));
  if (privileged && !(isExtensionOrigin(origin) || tokenOk(req))) {
    return 'forbidden: this endpoint requires the ChatPanel extension or a valid bridge token';
  }
  return null;
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
        // WHAT THIS AGENT CAN ALREADY REACH, so the client stops guessing. A CLI agent brings
        // its own connectors — a Slack MCP, a Jira MCP — that the extension cannot see, and
        // an agent that was never told it may use them answers "go and look it up yourself".
        // NAMES ONLY: a server's name is what a prompt needs; its URL, argv and env are what
        // a leak would be made of. Additive, so an older extension ignores it.
        const connectors = await connectorsFor(id).catch(() => []);
        return { id, label, available: a.ok, reason: a.reason, connectors };
      }),
  );
  const update = await checkForUpdate(VERSION).catch(() => ({ current: VERSION, updateAvailable: false }));
  // ADDITIVE, and the client's only way to know this bridge can host skill packages —
  // an older bridge simply omits it, which is what stops a newer extension assuming the
  // endpoints exist. Never let a scan failure cost the caller its health check.
  const skills = await skillsHealth().catch(() => null);
  // So Settings can show what a blank "Working directory" actually resolves to, instead
  // of leaving the user to discover it from where their files did not appear.
  json(res, 200, {
    ok: true, version: VERSION, agents, update,
    workspace: DEFAULT_WORKSPACE,
    ...(skills ? { skills } : {}),
  });
}

// --------------------------------------------------------------------------
// Skill packages (F6 S2). Read-only: the store serves what is already on disk.
// Installing FROM a hub waits for the scanner — a write endpoint that lands before
// the gate is a window in which unscanned packages can be written, and windows like
// that do not close on schedule.
//
// The three routes are the progressive-disclosure ladder, so a client pays for a
// skill's body only when it picks one, and for a reference file only when it needs it.
// --------------------------------------------------------------------------
async function handleSkillsList(res, extraDirs) {
  const { index, problems } = await skillIndex({ extraDirs });
  json(res, 200, { ok: true, skills: listRecords(index), problems });
}

async function handleSkillsQuarantined(res, extraDirs) {
  json(res, 200, { ok: true, quarantined: await quarantinedSkills(extraDirs) });
}

async function handleSkillRead(res, name, extraDirs) {
  const { index } = await skillIndex({ extraDirs });
  const skill = readRecord(index, name);
  if (!skill) return json(res, 404, { ok: false, error: 'unknown skill' });
  json(res, 200, { ok: true, skill });
}

async function handleSkillFile(res, name, relPath, extraDirs) {
  const { index } = await skillIndex({ extraDirs });
  const out = await readPackageFile(index, name, relPath);
  // One shape for every refusal: a caller learns that it may not have the file, not
  // whether the path exists, which is the difference between an error and an oracle.
  if (out.error) return json(res, out.error === 'unknown skill' ? 404 : 400, { ok: false, error: out.error });
  json(res, 200, { ok: true, ...out });
}

async function compatibleModels() {
  const rows = await Promise.all(
    Object.entries(ENGINES)
      .filter(([, entry]) => !entry.hidden)
      .map(async ([id, entry]) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'chatpanel',
        available: !!(await entry.engine.available().catch(() => ({ ok: false }))).ok,
      })),
  );
  return rows.filter((row) => row.available).map(({ available, ...row }) => row);
}

async function handleCompatibleModels(res, modelId = '') {
  const models = await compatibleModels();
  if (modelId) {
    const model = models.find((row) => row.id === modelId);
    return model ? json(res, 200, model) : json(res, 404, openAIError(new CompatError(`Model "${modelId}" not found`, 404, 'model')));
  }
  return json(res, 200, { object: 'list', data: models });
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

  // If the client disconnects (Stop, or the panel closes), stop caring about late
  // writes AND abort the run so the engine kills its CLI child instead of letting it
  // finish in the background. Older engines ignore the signal (harmless); the spawn
  // engines honor it via killOnAbort.
  let closed = false;
  // A run id the client can cancel BY NAME. Emitted first, before anything else, so Stop
  // works from the first millisecond rather than from whenever the engine gets going.
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
  const run = startRun(runId);
  const ac = { signal: run.signal, abort: () => run.cancel('client') };
  // BOTH close events. On a request whose body was already consumed, req 'close' does not
  // reliably signal a client disconnect — res 'close' does. Keeping both means a panel that
  // crashes or is closed still tears the CLI down, while the Stop button no longer depends
  // on either of them.
  const onGone = () => { closed = true; run.cancel('disconnected'); };
  req.on('close', onGone);
  res.on('close', onGone);
  res.on('error', onGone);

  const safeEmit = (obj) => { if (!closed) emit(obj); };
  emit({ type: 'run', id: runId });

  // WHERE THIS RUN WILL WRITE, said before it starts. "The agent created a file and I
  // cannot find it" was the single most confusing thing about a CLI agent, and the answer
  // used to depend on which engine answered — the filesystem root, the home directory, or
  // a temp folder the OS clears on its own schedule. Now there is one answer and it is
  // announced. Additive: a client that does not know `workdir` ignores it, and the same
  // information is repeated as a `status` line, which every client already renders.
  {
    const dir = resolveWorkdir(body.options?.workingDir);
    const chosen = !isDefaultWorkdir(body.options?.workingDir);
    const scope = writeScopeNote(body.agent, body.options?.permissionMode, dir);
    emit({ type: 'workdir', path: dir, isDefault: !chosen, writeScope: scope || undefined });
    emit({ type: 'status', text: `Working in ${dir}${chosen ? '' : ' (default)'}` });
    if (scope) emit({ type: 'status', text: scope });
  }

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
      { signal: ac.signal },
    );
  } catch (e) {
    log('error', `${body.agent} chat failed: ${e?.message || e}`);
    emit({ type: 'error', error: e?.message || String(e) });
  } finally {
    endRun(runId);
    if (session) deleteSession(session.id);
    if (!res.writableEnded) res.end();
  }
}

async function runCompatibleAgent(config, onDelta, res) {
  const target = ENGINES[config.agent];
  if (!target || target.hidden) throw new CompatError(`Unknown ChatPanel agent "${config.agent}"`, 400, 'model');
  const availability = await target.engine.available().catch((e) => ({ ok: false, reason: e?.message || String(e) }));
  if (!availability.ok) throw new CompatError(availability.reason || `${config.agent} is unavailable`, 503, 'model');

  const runId = `run_${Math.random().toString(36).slice(2, 10)}`;
  const run = startRun(runId);
  const onGone = () => run.cancel('disconnected');
  res.on('close', onGone);
  let output = '';
  try {
    await target.engine.chat(
      { messages: config.messages, system: config.system, options: config.options, images: [] },
      (event) => {
        if (event?.type === 'delta' && event.text) {
          output += event.text;
          onDelta(event.text);
        } else if (event?.type === 'done' && event.text && !output) {
          output = event.text;
          onDelta(event.text);
        }
      },
      { signal: run.signal },
    );
    return output;
  } finally {
    res.off('close', onGone);
    endRun(runId);
  }
}

function beginSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function writeData(res, value) {
  if (!res.writableEnded) res.write(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
}

function writeNamedEvent(res, name, value) {
  if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
}

async function compatibleBody(req, res, parser, errorShape) {
  try {
    return parser(await readBody(req));
  } catch (error) {
    json(res, error?.status || 400, errorShape(error?.message?.startsWith('Unexpected') ? new CompatError(`Bad JSON: ${error.message}`) : error));
    return null;
  }
}

async function handleOpenAIChatCompletions(req, res) {
  const config = await compatibleBody(req, res, parseChatCompletion, openAIError);
  if (!config) return;
  if (!config.stream) {
    try {
      const text = await runCompatibleAgent(config, () => {}, res);
      return json(res, 200, createChatCompletion(config.requestedModel, text));
    } catch (error) {
      if (!res.writableEnded) return json(res, error?.status || 500, openAIError(error));
      return;
    }
  }

  beginSse(res);
  const stream = chatCompletionStream(config.requestedModel, (event) => writeData(res, event));
  try {
    await runCompatibleAgent(config, (text) => stream.delta(text), res);
    stream.done();
  } catch (error) {
    writeData(res, openAIError(error));
  }
  writeData(res, '[DONE]');
  res.end();
}

async function handleOpenAICompletions(req, res) {
  const config = await compatibleBody(req, res, parseCompletion, openAIError);
  if (!config) return;
  if (!config.stream) {
    try {
      const text = await runCompatibleAgent(config, () => {}, res);
      return json(res, 200, createCompletion(config.requestedModel, text));
    } catch (error) {
      if (!res.writableEnded) return json(res, error?.status || 500, openAIError(error));
      return;
    }
  }

  beginSse(res);
  const stream = completionStream(config.requestedModel, (event) => writeData(res, event));
  try {
    await runCompatibleAgent(config, (text) => stream.delta(text), res);
    stream.done();
  } catch (error) {
    writeData(res, openAIError(error));
  }
  writeData(res, '[DONE]');
  res.end();
}

async function handleOpenAIResponses(req, res) {
  const config = await compatibleBody(req, res, parseResponse, openAIError);
  if (!config) return;
  if (!config.stream) {
    try {
      const text = await runCompatibleAgent(config, () => {}, res);
      return json(res, 200, createResponse(config.requestedModel, text));
    } catch (error) {
      if (!res.writableEnded) return json(res, error?.status || 500, openAIError(error));
      return;
    }
  }

  beginSse(res);
  const stream = responseStream(config.requestedModel, (event) => writeNamedEvent(res, event.type, event));
  try {
    await runCompatibleAgent(config, (text) => stream.delta(text), res);
    stream.done();
  } catch (error) {
    const event = { type: 'error', sequence_number: 0, ...openAIError(error) };
    writeNamedEvent(res, 'error', event);
  }
  res.end();
}

async function handleAnthropicMessages(req, res) {
  const config = await compatibleBody(req, res, parseAnthropicMessage, anthropicError);
  if (!config) return;
  if (!config.stream) {
    try {
      const text = await runCompatibleAgent(config, () => {}, res);
      return json(res, 200, createAnthropicMessage(config.requestedModel, text));
    } catch (error) {
      if (!res.writableEnded) return json(res, error?.status || 500, anthropicError(error));
      return;
    }
  }

  beginSse(res);
  const stream = anthropicStream(config.requestedModel, (name, event) => writeNamedEvent(res, name, event));
  try {
    await runCompatibleAgent(config, (text) => stream.delta(text), res);
    stream.done();
  } catch (error) {
    writeNamedEvent(res, 'error', anthropicError(error));
  }
  res.end();
}

/**
 * POST /cancel { id } — stop a run by name.
 *
 * Stop is now an instruction, not something inferred from a socket. Answers 200 whether or
 * not the run was still live: 'already finished' and 'cancelled' are the same outcome to the
 * caller, and returning 404 would make a harmless race look like a failure.
 */
async function handleCancel(req, res) {
  // readBody already PARSES. Wrapping it in JSON.parse threw on every call, so the id was
  // always empty and Stop silently cancelled nothing — the unit tests covered the registry
  // and not the handler that feeds it, which is exactly where this hid.
  let body = {};
  try { body = (await readBody(req)) || {}; } catch { /* an empty body cancels nothing */ }
  const id = String(body.id || '').trim();
  const cancelled = id ? cancelRun(id, 'stopped') : false;
  if (cancelled) log('info', `cancel: ${id} stopped by client`);
  return json(res, 200, { ok: true, cancelled });
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
  // ChatPanel's own bridge-native capabilities (skills today; redaction and more later) are
  // ALWAYS advertised — a CLI that added this server once gets them whether or not a browser
  // chat is open. The active session's page tools are added ON TOP when a chat is driving.
  const capTools = capabilityToolSpecs();

  if (msg.method === 'tools/list') {
    const pageTools = session
      ? session.specs.map((s) => ({
        name: s.name,
        description: s.description,
        inputSchema: s.parameters || { type: 'object', properties: {} },
      }))
      : [];
    return reply({ tools: [...capTools, ...pageTools] });
  }
  if (msg.method === 'tools/call') {
    // A capability tool runs in the bridge and needs no browser; a page tool relays to the
    // active chat. Capability tools win a name clash — they are ours and namespaced.
    const cap = await runCapabilityTool(msg.params?.name, msg.params?.arguments || {});
    if (cap) return reply(cap);
    if (!session) return fail(-32001, 'That tool needs an active ChatPanel chat with “Act on page” on. ChatPanel\'s own tools (chatpanel_*) work without one.');
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

// POST /mcp-remote — proxy ONE JSON-RPC message to a remote Streamable-HTTP MCP
// server FROM the bridge (server-side, no browser Origin header), so the extension
// can reach servers that reject browser origins (their own DNS-rebinding/CORS
// protection). Body: { url, headers?, message }. Returns the upstream
// { status, sessionId, contentType, body } for the extension to parse. Privileged
// route + SSRF guard, so it can't be driven by a page or relay into the LAN.
async function handleMcpRemote(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return json(res, 400, { error: 'Bad JSON: ' + e.message });
  }
  const { url, headers: hdrs, message } = body || {};
  if (!url || !message) return json(res, 400, { error: 'need url and message' });
  let target;
  try {
    target = assertPublicHttpUrl(url);
  } catch (e) {
    return json(res, 400, { error: String(e?.message || e) });
  }
  // Forward only safe, MCP-relevant client headers (auth, session, protocol, x-*);
  // never the Host/hop-by-hop headers. Content-Type/Accept are set by us.
  const fwd = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (hdrs && typeof hdrs === 'object') {
    for (const [k, v] of Object.entries(hdrs)) {
      const lk = k.toLowerCase();
      if (['authorization', 'mcp-session-id', 'mcp-protocol-version', 'x-api-key'].includes(lk) || lk.startsWith('x-')) {
        fwd[k] = String(v);
      }
    }
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30_000);
  try {
    const up = await fetch(target.href, { method: 'POST', headers: fwd, body: JSON.stringify(message), redirect: 'follow', signal: ac.signal });
    // A redirect may have landed on an internal host — re-check the final URL.
    try { if (up.url) assertPublicHttpUrl(up.url); } catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
    const text = await up.text().catch(() => '');
    return json(res, 200, {
      status: up.status,
      sessionId: up.headers.get('Mcp-Session-Id') || null,
      contentType: up.headers.get('Content-Type') || '',
      body: text,
    });
  } catch (e) {
    const why = e?.name === 'AbortError' ? 'timed out' : String(e?.message || e);
    return json(res, 502, { error: `couldn't reach MCP server ${target.host}: ${why}` });
  } finally {
    clearTimeout(t);
  }
}

// POST /fetch-title — fetch a PUBLIC web page and return ONLY its <title>, so a client can turn
// a bare URL into a readable [Title](url) link without the browser's Origin/CORS limits and
// without any third-party title service. This is the canonical "secure web fetch" the bridge
// offers on behalf of clients:
//   • Privileged route (extension origin or bridge token only) — a random page can't drive it.
//   • STRICTER SSRF guard than /mcp-remote (assertPublicWebUrl): loopback / LAN / metadata are
//     blocked unconditionally — a page fetch has no business touching internal hosts.
//   • Redirects are followed MANUALLY, re-validating EVERY hop, so it can never be bounced onto
//     an internal address (stronger than an after-the-fact final-URL check).
//   • Response is read with a hard byte cap and stops at </title> — we only need the <head>.
//   • No cookies / auth / referer are ever sent; only the title string is returned.
const FT_MAX_BYTES = 256 * 1024;
const FT_MAX_REDIRECTS = 5;
const FT_TIMEOUT_MS = 8000;

async function fetchTitleSafely(rawUrl) {
  let current = assertPublicWebUrl(rawUrl); // throws on non-http(s) / private / loopback / metadata
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FT_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= FT_MAX_REDIRECTS; hop++) {
      const res = await fetch(current.href, {
        method: 'GET',
        redirect: 'manual', // follow hops ourselves so each target is re-validated before we call it
        signal: ac.signal,
        headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en', 'User-Agent': `chatpanel-bridge/${VERSION} (+link-title)` },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = assertPublicWebUrl(new URL(res.headers.get('location'), current).href); // re-guard the redirect
        if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
        continue;
      }
      if (!res.ok) { if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } } return { title: null }; }
      const ct = res.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml/i.test(ct)) { if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } } return { title: null }; }
      return { title: extractTitle(await readCapped(res)), url: current.href };
    }
    throw new Error('too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

// Read the response body up to FT_MAX_BYTES, stopping as soon as we've seen the closing </title>.
async function readCapped(res) {
  if (!res.body?.getReader) return (await res.text().catch(() => '')).slice(0, FT_MAX_BYTES);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (/<\/title\s*>/i.test(out) || total >= FT_MAX_BYTES) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  return out;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#0*39|#x0*27);/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } });
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

async function handleFetchTitle(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { error: 'Bad JSON: ' + e.message }); }
  const url = body && body.url;
  if (!url || typeof url !== 'string') return json(res, 400, { error: 'need url' });
  try {
    const out = await fetchTitleSafely(url);
    return json(res, 200, { title: out.title || null, url: out.url || url });
  } catch (e) {
    const why = e?.name === 'AbortError' ? 'timed out' : String(e?.message || e);
    return json(res, 400, { error: `couldn't fetch title: ${why}` });
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
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    return json(res, 400, { error: 'bad request' });
  }
  // Block DNS-rebinding / cross-origin CSRF before any route runs.
  const blocked = guard(req, url.pathname);
  if (blocked) return json(res, 403, { error: blocked });
  try {
    if (req.method === 'GET' && url.pathname === '/health') return handleHealth(res);
    // Custom skill folders the user configured in the extension, passed per request. They
    // are the user's own absolute paths on their own machine; the bridge validates and
    // scans them, and the same traversal/symlink guards apply to any file read from them.
    const extraDirs = url.searchParams.getAll('dir');
    if (req.method === 'GET' && url.pathname === '/skills') return handleSkillsList(res, extraDirs);
    if (req.method === 'GET' && url.pathname === '/skills-quarantined') return handleSkillsQuarantined(res, extraDirs);
    if (req.method === 'GET' && url.pathname.startsWith('/skills/')) {
      const rest = url.pathname.slice('/skills/'.length);
      const cut = rest.indexOf('/file/');
      if (cut === -1) return handleSkillRead(res, decodeURIComponent(rest), extraDirs);
      return handleSkillFile(
        res,
        decodeURIComponent(rest.slice(0, cut)),
        decodeURIComponent(rest.slice(cut + '/file/'.length)),
        extraDirs,
      );
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') return handleCompatibleModels(res);
    if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
      return handleCompatibleModels(res, decodeURIComponent(url.pathname.slice('/v1/models/'.length)));
    }
    if (req.method === 'GET' && url.pathname === '/debug') {
      // L6: by default expose only version + agent AVAILABILITY (a boolean) — enough
      // to diagnose "is codex installed?". The full home dir, $PATH, and resolved
      // binary paths (which embed the username / home) leak environment detail, so
      // they're opt-in behind CHATPANEL_BRIDGE_DEBUG=1. The extension doesn't read
      // this route, so trimming it by default breaks nothing.
      const verbose = /^(1|true|yes|on)$/i.test(process.env.CHATPANEL_BRIDGE_DEBUG || '');
      return json(res, 200, {
        version: VERSION,
        agents: Object.fromEntries(AGENT_CLIS.map((name) => [name, verbose ? (findAgentBin(name) || null) : !!findAgentBin(name)])),
        ...(verbose ? { home: os.homedir(), path: process.env.PATH } : {}),
      });
    }
    if (req.method === 'POST' && url.pathname === '/chat') return handleChat(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return handleOpenAIChatCompletions(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/completions') return handleOpenAICompletions(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/responses') return handleOpenAIResponses(req, res);
    if (req.method === 'POST' && url.pathname === '/v1/messages') return handleAnthropicMessages(req, res);
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
    if (req.method === 'GET' && url.pathname === '/channels') return handleChannels(req, res, 'status');
    if (req.method === 'POST' && url.pathname.startsWith('/channels/')) {
      return handleChannels(req, res, url.pathname.slice('/channels/'.length));
    }
    if (req.method === 'POST' && url.pathname === '/cancel') return handleCancel(req, res);
    if (req.method === 'POST' && url.pathname === '/tool-result') return handleToolResult(req, res);
    if (req.method === 'POST' && url.pathname === '/mcp-local') return handleMcpLocal(req, res);
    if (req.method === 'POST' && url.pathname === '/mcp-remote') return handleMcpRemote(req, res);
    if (req.method === 'POST' && url.pathname === '/fetch-title') return handleFetchTitle(req, res);
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
  enrichPath(); // so codex/agy (Antigravity) are found even under a minimal service PATH
  enrichAgentEnv(); // and so env-authenticated CLIs (dsh) have their key under launchd
  ensureToken(); // per-install bearer token for privileged routes (defense-in-depth)
  // Fail LOUD on a port clash. The bridge binds a FIXED 4319 so the extension always
  // finds it; if it's taken, say how to recover instead of dying on a raw stack trace.
  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      log('error', `Port ${PORT} is already in use — another app (or a second bridge) has it.`);
      log('error', `Fix: free the port, or run with CHATPANEL_BRIDGE_PORT=<port> and set the same Bridge URL in the extension's settings.`);
      process.exit(1);
    }
    log('error', `bridge server error: ${e?.message || e}`);
    process.exit(1);
  });
  // Leaving a CLI running after the bridge exits is how orphans are made — and the user has
  // no way to find or stop them, because the thing that spawned them is gone.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      const n = cancelAll('shutdown');
      if (n) log('info', `shutdown: stopped ${n} running agent${n === 1 ? '' : 's'}`);
      // Give SIGTERM a moment to land before the process goes; killTree escalates on its own.
      setTimeout(() => process.exit(0), n ? 300 : 0).unref?.();
      if (!n) process.exit(0);
    });
  }

  server.listen(PORT, HOST, async () => {
    log('info', `listening on http://${HOST}:${PORT}`);
    // M7: a non-loopback bind disables the anti-DNS-rebinding Host check (hostAllowed
    // returns true for any Host), so the only inbound guard left is the per-install
    // token / extension Origin. Make that trade-off LOUD — it's rarely what you want.
    if (!LOOPBACK_HOSTNAMES.has(HOST)) {
      log('error', `⚠ SECURITY: bound to NON-LOOPBACK host ${HOST}. The anti-rebinding Host check is OFF, so any device that reaches this port (and any web page via a spoofed Host header) can drive local agents — gated only by the bridge token. Only do this on a trusted, firewalled network; prefer 127.0.0.1.`);
    }
    for (const [, { engine, label, hidden }] of Object.entries(ENGINES)) {
      if (hidden) continue;
      const a = await engine.available().catch(() => ({ ok: false }));
      log('info', `  ${a.ok ? '✓' : '✕'} ${label}${a.ok ? '' : ' — ' + (a.reason || 'unavailable')}`);
    }
    log('info', 'Open the ChatPanel side panel; installed agents (Claude Code, Codex, Antigravity) appear automatically.');
    // A channel someone connected last week must come back by itself after a reboot — nobody
    // is at the keyboard to press start, which is the entire premise of driving this from a
    // phone. Nothing loads and nothing runs until a bot has actually been connected.
    channelService()
      .then((svc) => svc.startIfConfigured())
      .then((r) => {
        if (r?.skipped) return;
        if (r?.ok) log('info', 'channels: telegram connected — polling for messages');
        else log('error', `channels: telegram not started — ${r?.error || 'unknown error'}`);
      })
      .catch((e) => log('error', `channels: ${e?.message || e}`));
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
