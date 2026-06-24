// Custom ("bring your own") engine — runs ANY CLI the user onboards from the
// extension's Agents settings (opencode, pi, ollama, a shell script, …) WITHOUT
// a bridge code change per tool. The command spec travels in the chat request's
// `options.custom`; this engine resolves the command cross-platform (PATH /
// Windows cli.js+.cmd / WSL — same launcher as Claude), pipes the prompt in, and
// streams output back.
//
// HARD Pro gate: a custom agent only runs if the request carries a valid,
// server-signed entitlement token (verified OFFLINE here — no network). A forked
// client or a raw POST can't forge it, so this is real gating, not UI.
//
// Output formats:
//   'text' (default) — stream stdout straight through as text deltas. Works for
//                      any program that prints a reply.
//   'claude-stream-json' — parse Claude Code-style stream-json (for tools that
//                      speak it), reusing the Claude engine's parser.

import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveCommand, buildSpawnSpec, selfMcpStdio } from '../env.js';
import { isProEntitled } from '../entitlement.js';
import { handleMessage } from './claude.js';
import { buildCliPrompt } from './prompt.js';

// Write base64 data-URL images to temp files so a custom CLI can take them via
// its configured `imageArg` template (e.g. "-i {path}", "@{path}"). Returns paths.
async function writeImages(images, tag) {
  const files = [];
  for (let i = 0; i < (images?.length || 0); i++) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(images[i]?.dataUrl || '');
    if (!m) continue;
    const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
    const file = path.join(os.tmpdir(), `chatpanel-custom-img-${tag}-${i}.${ext}`);
    await writeFile(file, Buffer.from(m[2], 'base64'));
    files.push(file);
  }
  return files;
}

// Expand the user's `imageArg` template across the image files into argv tokens.
// "{path}" is substituted per image; a template without it appends the path.
function imageTokensFor(imageArg, files) {
  const tmpl = String(imageArg || '').trim();
  if (!tmpl || !files.length) return [];
  const tokens = [];
  for (const f of files) {
    tokens.push(
      ...(tmpl.includes('{path}')
        ? tmpl.replaceAll('{path}', f).split(/\s+/).filter(Boolean)
        : [...tmpl.split(/\s+/).filter(Boolean), f]),
    );
  }
  return tokens;
}

// Idle timeout: re-armed on every stdout/stderr chunk, so a long run that keeps
// streaming never trips it — only true silence does. Override with
// CHATPANEL_CUSTOM_TIMEOUT_MS (ms).
const IDLE_MS = Number(process.env.CHATPANEL_CUSTOM_TIMEOUT_MS) || 180_000;

// Many CLIs emit ANSI colour/escape codes even when piped (kiro-cli does), which
// leak into the answer as `\x1b[38;5;141m…`. Strip them from text output. (We
// also set NO_COLOR on the child env, but this is the robust backstop.)
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');
const OPENCODE_STABLE_MCP_URL = 'http://127.0.0.1:4319/mcp';
const CHATPANEL_STABLE_MCP_URL = 'http://127.0.0.1:4319/mcp';

export async function available() {
  // The engine ships in every bridge; individual custom agents are user-defined
  // (Pro) and validated per request and via /agent-check.
  return { ok: true };
}

// Parse a CLI's "list models" stdout into model ids. Tools format this very
// differently (one-per-line, a table, "provider/model", …), so this is
// best-effort: take the first token of each line that looks like an id and skip
// obvious headers/prose. The picker always allows a custom value as a fallback.
function parseModelList(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || '').split('\n')) {
    const tok = raw.trim().split(/\s+/)[0] || '';
    if (!/^[A-Za-z0-9][\w./:-]{1,79}$/.test(tok)) continue;
    if (/^(name|model|models|id|provider|available|usage|options|commands)$/i.test(tok)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= 200) break;
  }
  return out;
}

// Unified model listing: run the agent's CONFIGURED list-models invocation
// (e.g. pi `--list-models`, opencode `models`) and parse the output. Returns []
// when not configured. Pro-gated like chat (it runs the user's CLI).
export async function listModels(options = {}) {
  if (!(await isProEntitled(options.entitlement))) {
    throw new Error('Custom agents require ChatPanel Pro.');
  }
  const spec = options.custom || {};
  return listSpecModels(spec.command, spec.listModelsArgs, options.workingDir);
}

// Shared model listing (no Pro gate): run a CLI's list-models invocation and
// parse it. Used by the Pro custom engine (gated above) AND built-in CLI agents.
export async function listSpecModels(command, listModelsArgs, workingDir) {
  const listArgs = String(listModelsArgs || '').trim();
  if (!command || !listArgs) return [];
  const resolved = resolveCommand(command);
  if (!resolved) throw new Error(`Couldn't find "${command}".`);
  const cwd = workingDir ? path.resolve(workingDir) : null;
  const [bin, argv, opts] = buildSpawnSpec(resolved, listArgs.split(/\s+/).filter(Boolean), cwd);
  opts.env = { ...(opts.env || process.env), NO_COLOR: '1', CLICOLOR: '0' };
  const stdout = await new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, argv, opts); } catch (e) { return reject(new Error(`Failed to start ${command}: ${e.message}`)); }
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Listing models timed out.')); }, 20000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Failed to start ${command}: ${e.message}`)); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
    try { child.stdin.end(); } catch { /* some CLIs don't read stdin */ }
  });
  return parseModelList(stdout);
}

function mcpToolSpecs(mcp) {
  return (mcp?.specs || []).filter((s) => s?.name);
}

function jsIdentifier(name, index) {
  const id = String(name).replace(/[^A-Za-z0-9_$]/g, '_');
  return /^[A-Za-z_$]/.test(id) ? id : `tool_${index}_${id}`;
}

export function piToolArgs(extensionFile, mcp) {
  return ['--extension', extensionFile];
}

export function trustToolArgs(template, mcp) {
  const tmpl = String(template || '').trim();
  const names = mcpToolSpecs(mcp).map((s) => s.name).filter(Boolean);
  if (!tmpl || !names.length) return [];
  const value = names.join(',');
  return tmpl.includes('{tools}')
    ? tmpl.replaceAll('{tools}', value).split(/\s+/).filter(Boolean)
    : [...tmpl.split(/\s+/).filter(Boolean), value];
}

export function stableMcpSetupCommand(spec = {}) {
  if (spec.stableMcpSetupCommand) return spec.stableMcpSetupCommand;
  return `opencode mcp add chatpanel --url ${CHATPANEL_STABLE_MCP_URL}`;
}

export function stableMcpSetupPlan(spec = {}) {
  const args = Array.isArray(spec.stableMcpSetupArgs) ? spec.stableMcpSetupArgs.filter((a) => a != null).map(String) : null;
  if (!args?.length) return null;
  return { command: spec.stableMcpSetupCommandName || spec.command, args };
}

export function buildPiExtensionSource(mcp) {
  const specs = mcpToolSpecs(mcp);
  const declarations = specs.map((spec, index) => {
    const id = jsIdentifier(spec.name, index);
    const schema = spec.parameters || { type: 'object', properties: {} };
    return `const ${id}Tool = {
  name: ${JSON.stringify(spec.name)},
  label: ${JSON.stringify(spec.name)},
  description: ${JSON.stringify(spec.description || spec.name)},
  parameters: ${JSON.stringify(schema)},
  async execute(toolCallId, params, signal) {
    return callMcpTool(${JSON.stringify(spec.name)}, toolCallId, params, signal);
  },
};`;
  }).join('\n\n');
  const registrations = specs.map((spec, index) => {
    const id = jsIdentifier(spec.name, index);
    return `  pi.registerTool(${id}Tool);`;
  }).join('\n');

  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MCP_URL = ${JSON.stringify(mcp.url)};

function contentFromDataUrl(dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(String(dataUrl || ""));
  return match ? { type: "image", data: match[2], mimeType: match[1] } : null;
}

function normalizeContent(content) {
  const out = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (item?.type === "text") {
      out.push({ type: "text", text: String(item.text ?? "") });
    } else if (item?.type === "image" && item.data) {
      out.push({ type: "image", data: String(item.data), mimeType: String(item.mimeType || "image/png") });
    } else if (typeof item?.image === "string") {
      const img = contentFromDataUrl(item.image);
      if (img) out.push(img);
      if (item.text) out.push({ type: "text", text: String(item.text) });
    }
  }
  return out.length ? out : [{ type: "text", text: "ok" }];
}

async function callMcpTool(toolName, toolCallId, params, signal) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: toolCallId || String(Date.now()),
      method: "tools/call",
      params: { name: toolName, arguments: params || {} },
    }),
    signal,
  });
  const message = await response.json();
  if (message.error) {
    return {
      content: [{ type: "text", text: \`error: \${message.error.message || JSON.stringify(message.error)}\` }],
      details: { error: message.error },
    };
  }
  return {
    content: normalizeContent(message.result?.content),
    details: message.result ?? {},
  };
}

${declarations}

export default function (pi: ExtensionAPI) {
${registrations}
}
`;
}

async function writePiExtension(mcp, tag) {
  const file = path.join(os.tmpdir(), `chatpanel-pi-tools-${tag}.ts`);
  await writeFile(file, buildPiExtensionSource(mcp));
  return file;
}

async function opencodeHasStableMcpConfig() {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const files = [
    path.join(configHome, 'opencode', 'opencode.jsonc'),
    path.join(os.homedir(), 'Library', 'Application Support', 'opencode', 'opencode.jsonc'),
  ];
  for (const file of files) {
    try {
      const text = await readFile(file, 'utf8');
      if (text.includes(OPENCODE_STABLE_MCP_URL)) return true;
    } catch {
      /* missing config is fine */
    }
  }
  return false;
}

export async function commandOutput(command, args, cwd) {
  const resolved = resolveCommand(command);
  if (!resolved) return '';
  const [bin, argv, opts] = buildSpawnSpec(resolved, args, cwd || null);
  return new Promise((resolve) => {
    const child = spawn(bin, argv, opts);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(out + err);
    }, 4000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(out + err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out + err);
    });
    try { child.stdin.end(); } catch { /* ignore */ }
  });
}

async function kiroHasStableMcpConfig(command, cwd) {
  for (const scope of ['workspace', 'global', 'default']) {
    const out = await commandOutput(command, ['mcp', 'list', scope], cwd);
    if (out.includes(CHATPANEL_STABLE_MCP_URL) || /chatpanel_browser/i.test(out)) return true;
  }
  return false;
}

async function hasStableMcpConfig(spec, cwd) {
  if (spec.stableMcpConfigCheck === 'kiro') return kiroHasStableMcpConfig(spec.command || 'kiro-cli', cwd);
  if (spec.stableMcpConfigCheck === 'opencode') return opencodeHasStableMcpConfig();
  return false;
}

async function runStableMcpSetup(plan, cwd) {
  const resolved = resolveCommand(plan.command);
  if (!resolved) throw new Error(`Couldn't find "${plan.command}" to set up browser tools.`);
  const [bin, argv, opts] = buildSpawnSpec(resolved, plan.args, cwd || null);
  opts.env = { ...(opts.env || process.env), NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR: '0', TERM: 'dumb' };
  await new Promise((resolve, reject) => {
    let child;
    try { child = spawn(bin, argv, opts); } catch (e) { return reject(new Error(`Failed to start ${plan.command}: ${e.message}`)); }
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${plan.command} MCP setup timed out.`));
    }, 20_000);
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start ${plan.command}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`${plan.command} MCP setup exited ${code}: ${stderr.trim().split('\n').pop() || 'failed'}`));
    });
    try { child.stdin.end(); } catch { /* ignore */ }
  });
}

export async function ensureStableMcpConfig(spec, cwd, label, emit, deps = {}) {
  if (!spec.requiresStableMcp) return true;
  const hasConfig = deps.hasConfig || hasStableMcpConfig;
  const runSetup = deps.runSetup || runStableMcpSetup;
  if (await hasConfig(spec, cwd)) return true;

  const setupCommand = stableMcpSetupCommand(spec);
  if (!spec.autoSetupStableMcp) {
    const text = `${label} needs one-time browser-tool setup: ${setupCommand}`;
    emit({ type: 'status', text });
    throw new Error(text);
  }

  const plan = stableMcpSetupPlan(spec);
  if (!plan?.command) {
    const text = `${label} needs one-time browser-tool setup: ${setupCommand}`;
    emit({ type: 'status', text });
    throw new Error(text);
  }

  emit({ type: 'status', text: `${label} is setting up one-time browser tools...` });
  await runSetup(plan, cwd);
  if (await hasConfig(spec, cwd)) return true;
  throw new Error(`${label} browser-tool setup completed, but the MCP server is still not visible. Run: ${setupCommand}`);
}

export async function chat({ messages, system, options, images }, emit) {
  // Pro gate — verified, not just UI. No valid signed entitlement → no run.
  if (!(await isProEntitled(options.entitlement))) {
    throw new Error('Custom agents require ChatPanel Pro. Upgrade in Settings to bring your own CLI agent.');
  }
  return runSpec(options.custom || {}, { messages, system, options, images }, emit);
}

// Run a CLI agent from a spec — SHARED by the Pro custom engine (gated in chat()
// above) and the built-in CLI engines (pi/opencode/kiro). This never gates; the
// built-in agents are bounded instead by the extension's free 1-agent limit.
export async function runSpec(spec, { messages, system, options = {}, images }, emit) {
  if (!spec.command) throw new Error('This agent has no command configured.');

  const resolved = resolveCommand(spec.command);
  if (!resolved) {
    throw new Error(`Couldn't find "${spec.command}". Enter its full path, or install it on your PATH (or in WSL).`);
  }

  const prompt = buildCliPrompt(messages, system);
  let cwd = options.workingDir ? path.resolve(options.workingDir) : null;
  const label = spec.label || spec.command;
  const fmt = ['claude-stream-json', 'opencode-json'].includes(spec.format) ? spec.format : 'text';

  // Args: either a real array or a space-split string. With promptVia:'arg' we
  // substitute {prompt} (or append it if there's no placeholder); otherwise the
  // prompt goes in on stdin.
  const promptVia = spec.promptVia === 'arg' ? 'arg' : 'stdin';
  let args = Array.isArray(spec.args)
    ? spec.args.slice()
    : spec.args
      ? String(spec.args).split(/\s+/).filter(Boolean)
      : [];
  // User-supplied extra CLI flags (Settings → agent → "Extra arguments"), placed
  // right after the base args/subcommand — e.g. opencode `run --format json
  // --dangerously-skip-permissions`. Applies to every built-in & custom CLI agent.
  if (options.extraArgs) args.push(...String(options.extraArgs).split(/\s+/).filter(Boolean));
  // Inject the selected model via the agent's CONFIGURED model-arg template
  // (e.g. "--model {model}" or, for opencode, "-m {model}" with provider/model).
  // Without a template we can't know how this CLI takes a model, so options.model
  // is ignored — preserving back-compat with agents that bake the model into args.
  if (options.model && spec.modelArg) {
    const tmpl = String(spec.modelArg);
    const injected = tmpl.includes('{model}')
      ? tmpl.replaceAll('{model}', options.model).split(/\s+/).filter(Boolean)
      : [...tmpl.split(/\s+/).filter(Boolean), options.model];
    // APPEND (not prepend): subcommand CLIs (opencode `run`, kiro `chat`) must
    // keep the subcommand first — `opencode -m X run` makes `run` look like a
    // project path, so it never loads opencode.json / its MCP servers.
    args = [...args, ...injected];
  }
  // Images: write to temp files, expand the agent's imageArg template, then place
  // the tokens. An explicit {images} placeholder in args wins; otherwise they go
  // just before the prompt (arg mode) or get appended (stdin mode).
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const imageFiles = spec.imageArg ? await writeImages(images, tag) : [];
  const mcpFiles = [];
  const cleanup = () => [...imageFiles, ...mcpFiles].forEach((f) => unlink(f).catch(() => {}));

  // Browser tools: when armed (options.mcp) AND this CLI knows how to take an MCP
  // config file (spec.mcpArg, e.g. "--mcp-config {file}"), write a standard
  // mcpServers JSON pointing at the bridge's stdio MCP proxy and inject the flag.
  // Covers any CLI that reads the de-facto {mcpServers:{name:{command,args}}} shape.
  if (options.mcp?.url && spec.toolAdapter === 'pi-extension') {
    const extensionFile = await writePiExtension(options.mcp, tag);
    mcpFiles.push(extensionFile);
    args = [...piToolArgs(extensionFile, options.mcp), ...args];
  } else if (options.mcp?.url && spec.mcpArg) {
    const name = options.mcp.serverName || 'chatpanel_browser';
    const { command, args: pargs } = selfMcpStdio(options.mcp.url);
    const cfgFile = path.join(os.tmpdir(), `chatpanel-mcp-${tag}.json`);
    await writeFile(cfgFile, JSON.stringify({ mcpServers: { [name]: { command, args: pargs } } }));
    mcpFiles.push(cfgFile);
    const tmpl = String(spec.mcpArg);
    const tokens = tmpl.includes('{file}')
      ? tmpl.replaceAll('{file}', cfgFile).split(/\s+/).filter(Boolean)
      : [...tmpl.split(/\s+/).filter(Boolean), cfgFile];
    args = [...tokens, ...args];
  }
  if (options.mcp?.url && spec.trustToolsArg) {
    args.push(...trustToolArgs(spec.trustToolsArg, options.mcp));
  }
  // Some CLIs only load MCP from their persistent config, so ensure that stable
  // /mcp endpoint is present before letting the agent answer with no tools.
  if (options.mcp?.url) await ensureStableMcpConfig(spec, cwd, label, emit);

  const imageTokens = imageTokensFor(spec.imageArg, imageFiles);
  let placedImages = false;
  if (imageTokens.length) {
    args = args.flatMap((a) => {
      if (a === '{images}') {
        placedImages = true;
        return imageTokens;
      }
      return [a];
    });
  }

  if (promptVia === 'arg') {
    let placed = false;
    args = args.map((a) => {
      if (a.includes('{prompt}')) {
        placed = true;
        return a.replaceAll('{prompt}', prompt);
      }
      return a;
    });
    if (!placed) {
      if (imageTokens.length && !placedImages) args.push(...imageTokens); // images, then prompt
      args.push(prompt);
    }
  } else if (imageTokens.length && !placedImages) {
    args.push(...imageTokens); // stdin prompt: image tokens go on argv
  }

  const [bin, argv, opts] = buildSpawnSpec(resolved, args, cwd);
  // Discourage CLIs from colourizing output (kiro-cli etc.) when piped.
  opts.env = { ...(opts.env || process.env), NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR: '0', TERM: 'dumb' };

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, opts);
    } catch (e) {
      cleanup();
      return reject(new Error(`Failed to start ${label}: ${e.message}`));
    }

    let stderr = '';
    let streamedAny = false;
    let resultText = '';
    let jsonBuf = '';

    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        cleanup();
        reject(new Error(`${label} timed out — no output for ${Math.round(IDLE_MS / 1000)}s.`));
      }, IDLE_MS);
    };
    armIdle();

    child.stdout.on('data', (d) => {
      armIdle();
      const s = d.toString();
      if (fmt === 'claude-stream-json') {
        jsonBuf += s;
        let nl;
        while ((nl = jsonBuf.indexOf('\n')) >= 0) {
          const line = jsonBuf.slice(0, nl).trim();
          jsonBuf = jsonBuf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const r = handleMessage(msg, emit, streamedAny);
          if (r.streamed) streamedAny = true;
          if (r.result != null) resultText = r.result;
        }
      } else if (fmt === 'opencode-json') {
        // opencode `run --format json` emits newline-delimited events: text parts,
        // tool/tool_use, and errors. Extract the answer text + surface tools/errors.
        jsonBuf += s;
        let nl;
        while ((nl = jsonBuf.indexOf('\n')) >= 0) {
          const line = jsonBuf.slice(0, nl).trim();
          jsonBuf = jsonBuf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'text' && ev.part?.text) {
            streamedAny = true;
            emit({ type: 'delta', text: ev.part.text });
          } else if (ev.type === 'tool' || ev.type === 'tool_use') {
            const p = ev.part || {};
            emit({ type: 'tool', name: p.tool || p.name || p.type || 'tool', summary: '' });
          } else if (ev.type === 'error') {
            const msg = ev.error?.data?.message || ev.error?.message || ev.error?.name || 'error';
            emit({ type: 'status', text: String(msg).slice(0, 300) });
          }
        }
      } else {
        streamedAny = true;
        emit({ type: 'delta', text: stripAnsi(s) });
      }
    });
    child.stderr.on('data', (d) => { armIdle(); stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(idleTimer);
      cleanup();
      reject(new Error(`Failed to start ${label}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(idleTimer);
      cleanup();
      if (code === 0) {
        emit({ type: 'done', text: streamedAny ? '' : resultText });
        resolve();
      } else {
        reject(new Error(`${label} exited ${code}: ${stderr.trim().split('\n').pop() || 'failed'}`));
      }
    });

    if (promptVia === 'stdin') child.stdin.write(prompt);
    child.stdin.end();
  });
}
