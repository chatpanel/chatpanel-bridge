// Claude Code engine — drives the Claude Code CLI (`claude --print`) the SAME
// way the Codex engine drives `codex exec`, but with cross-platform launching so
// it works no matter where `claude` lives:
//
//   • macOS / Linux / WSL-native Node — spawn the native `claude` on PATH.
//   • Windows (native install) — run the package's cli.js with our own Node/Bun
//     (npm's claude.cmd/.ps1 shims aren't directly spawnable → "spawn …ENOENT").
//   • Windows host + claude only in WSL — cross the boundary via `wsl.exe`.
//   • Last resort — the in-process Claude Agent SDK (bundled cli.js), if present.
//
// Resolution lives in env.js (resolveClaude); set CHATPANEL_CLAUDE_PATH to force
// a specific executable. It uses your *local* Claude Code login. By default the
// agent can READ your code but cannot write/run shell unless the agent's
// permissionMode is 'acceptEdits'/'bypassPermissions' in ChatPanel Settings.

import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveClaude, buildSpawnSpec, isCompiledBinary, selfMcpStdio } from '../env.js';
import { buildCliPrompt } from './prompt.js';

// Write base64 data-URL images to temp files. Claude Code reads them with its
// Read tool (which feeds images to the model as vision), so we just reference the
// paths in the prompt — no custom image flag needed. Returns paths (caller cleans).
async function writeImages(images, tag) {
  const files = [];
  for (let i = 0; i < (images?.length || 0); i++) {
    const m = /^data:([^;]+);base64,(.+)$/s.exec(images[i]?.dataUrl || '');
    if (!m) continue;
    const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'png';
    const file = path.join(os.tmpdir(), `chatpanel-claude-img-${tag}-${i}.${ext}`);
    await writeFile(file, Buffer.from(m[2], 'base64'));
    files.push(file);
  }
  return files;
}

// Idle timeout: kill the run only after this long with NO output. The timer
// re-arms on every stdout/stderr chunk, so a task that keeps streaming can run
// indefinitely — only a truly stuck/silent process is killed. Override with
// CHATPANEL_CLAUDE_TIMEOUT_MS (ms).
const IDLE_MS = Number(process.env.CHATPANEL_CLAUDE_TIMEOUT_MS) || 180_000;
// Read-only tools allowed without approval in headless mode; writes/shell are
// gated behind the agent's permission mode.
const READONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task'];

let lastReason = 'Claude Code not found.';
let lastProbe = 0;
let cachedOk = false;
export async function available() {
  // Availability = "can we launch claude somehow" (native / cli.js / WSL / SDK),
  // NOT "does `claude --version` exit 0" (which fails when it just needs login).
  if (!cachedOk && Date.now() - lastProbe > 4000) {
    lastProbe = Date.now();
    try {
      const spec = resolveClaude();
      if (spec) {
        cachedOk = true;
      } else if (!isCompiledBinary() && (await loadSdk())) {
        cachedOk = true;
      } else {
        cachedOk = false;
        lastReason =
          process.platform === 'win32'
            ? 'Claude Code not found on Windows PATH or in WSL. Install it (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in — in Windows or in your WSL distro.'
            : 'Claude Code not found on PATH. Install it (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in.';
      }
    } catch {
      cachedOk = false;
    }
  }
  return cachedOk ? { ok: true } : { ok: false, reason: lastReason };
}

// Claude Code has no "list models" command — it takes stable aliases (or full
// ids). Return the common aliases so the picker has sensible options; the user
// can still type any model string (e.g. claude-opus-4-8).
export async function listModels() {
  return ['opus', 'sonnet', 'haiku'];
}

export function claudeMcpConfig(mcp) {
  if (!mcp?.url || !Array.isArray(mcp.specs) || !mcp.specs.length) return null;
  const serverName = mcp.serverName || 'chatpanel_browser';
  const { command, args } = selfMcpStdio(mcp.url);
  const toolNames = [...new Set(mcp.specs.map((s) => s?.name).filter(Boolean))];
  return {
    serverName,
    config: { mcpServers: { [serverName]: { command, args } } },
    allowedTools: toolNames.map((name) => `mcp__${serverName}__${name}`),
  };
}

// Spawn claude (however it resolves) and stream its stream-json output via
// `emit`. Resolves with { streamedAny, resultText } once it closes 0. Returns
// null (no spawn) when claude can't be resolved, so the caller can fall back.
function runClaude({ prompt, args, cwd, emit }) {
  const spec = resolveClaude();
  if (!spec) return null;
  const [bin, argv, opts] = buildSpawnSpec(spec, args, cwd);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, opts);
    } catch (e) {
      return reject(new Error(`Failed to start claude: ${e.message}`));
    }

    let stdout = '';
    let stderr = '';
    let streamedAny = false;
    let resultText = '';

    let idleTimer;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`Claude Code timed out — no output for ${Math.round(IDLE_MS / 1000)}s.`));
      }, IDLE_MS);
    };
    armIdle();

    child.stdout.on('data', (d) => {
      armIdle();
      stdout += d.toString();
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not a JSON event line
        }
        const r = handleMessage(msg, emit, streamedAny);
        if (r.streamed) streamedAny = true;
        if (r.result != null) resultText = r.result;
      }
    });
    child.stderr.on('data', (d) => { armIdle(); stderr += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(idleTimer);
      reject(new Error(`Failed to start claude (${bin}): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(idleTimer);
      if (code === 0) resolve({ streamedAny, resultText });
      else reject(new Error(`Claude Code exited ${code}: ${stderr.trim().split('\n').pop() || 'failed'}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Map one stream-json message to emit() calls. Returns { streamed, result }.
// The CLI's stream-json mirrors the SDK message shapes. Exported so the custom
// engine can reuse it for agents that emit Claude-style stream-json.
export function handleMessage(msg, emit, alreadyStreamed) {
  const out = { streamed: false, result: null };
  if (msg.type === 'stream_event') {
    const ev = msg.event;
    if (ev?.type === 'content_block_delta') {
      if (ev.delta?.type === 'text_delta') {
        out.streamed = true;
        emit({ type: 'delta', text: ev.delta.text });
      } else if (ev.delta?.type === 'thinking_delta') {
        emit({ type: 'reasoning', text: ev.delta.thinking || '' });
      }
    }
  } else if (msg.type === 'assistant') {
    for (const block of msg.message?.content || []) {
      if (block.type === 'tool_use') {
        emit({ type: 'tool', name: block.name, summary: toolSummary(block) });
      } else if (block.type === 'text' && !alreadyStreamed) {
        out.streamed = true;
        emit({ type: 'delta', text: block.text });
      }
    }
  } else if (msg.type === 'result') {
    if (msg.subtype === 'success') out.result = msg.result || '';
    else emit({ type: 'status', text: `(${msg.subtype})` });
  }
  return out;
}

export async function chat({ messages, system, options, images }, emit) {
  const permissionMode = options.permissionMode || 'default';
  // Explicit project dir, else null → CLI runs in home (or WSL home).
  const cwd = options.workingDir ? path.resolve(options.workingDir) : null;

  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const args = ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];

  // Browser-tools relay: ChatPanel hands this CLI the page-action tools through
  // the bridge's stdio MCP proxy, which forwards each call to the per-chat HTTP
  // MCP session and then to the extension.
  // options.mcp = { url, serverName, specs }. We pre-allow the tools so a headless
  // run doesn't block on approval, and merge alongside the user's own MCP servers.
  const mcpFiles = [];
  const mcpAllow = [];
  const mcpConfig = claudeMcpConfig(options.mcp);
  if (mcpConfig) {
    const cfgFile = path.join(os.tmpdir(), `chatpanel-mcp-${tag}.json`);
    await writeFile(cfgFile, JSON.stringify(mcpConfig.config));
    mcpFiles.push(cfgFile);
    args.push('--mcp-config', cfgFile);
    mcpAllow.push(...mcpConfig.allowedTools);
  }

  // Gate writes/shell behind the chosen mode; otherwise restrict to read-only
  // tools so headless runs never block on an approval prompt. The relayed browser
  // tools are always pre-allowed (the user explicitly armed them this turn).
  if (permissionMode === 'bypassPermissions') args.push('--permission-mode', 'bypassPermissions');
  else if (permissionMode === 'acceptEdits') {
    args.push('--permission-mode', 'acceptEdits');
    if (mcpAllow.length) args.push('--allowedTools', ...mcpAllow);
  } else args.push('--allowedTools', ...READONLY_TOOLS, ...mcpAllow);

  // Native Claude Code behavior; append the user's own system prompt if they set
  // one (no ChatPanel persona injected).
  if (system) args.push('--append-system-prompt', system);
  if (options.model) args.push('--model', options.model);
  // Default loads your ~/.claude + project settings (skills, MCP, CLAUDE.md).
  // "Use my local skills & config" off → run clean.
  if (options.useLocalConfig === false) args.push('--setting-sources', '');

  // Attach images by writing them to temp files and asking Claude Code to Read
  // them — its Read tool loads images as vision (no special flag needed).
  const imageFiles = await writeImages(images, tag);
  const cleanup = () => {
    imageFiles.forEach((f) => unlink(f).catch(() => {}));
    mcpFiles.forEach((f) => unlink(f).catch(() => {}));
  };
  let prompt = buildCliPrompt(messages);
  if (imageFiles.length) {
    prompt += `\n\nThe user attached ${imageFiles.length} image file(s). Use the Read tool to view ${
      imageFiles.length === 1 ? 'it' : 'them'
    }: ${imageFiles.join(', ')}`;
  }

  if (options.extraArgs) {
    const extra = String(options.extraArgs).split(/\s+/).filter(Boolean);
    // Never let caller-supplied extras re-open the read-only boundary the mode
    // flags above establish. If ANY security-sensitive flag is present, drop the
    // whole extraArgs (these tokens take values, so partial filtering is unsafe).
    const FORBIDDEN = /^--?(permission-mode|allowed-?tools|disallowed-?tools|dangerously|add-dir|mcp-config|setting-sources|permission-prompt-tool)/i;
    if (extra.some((t) => FORBIDDEN.test(t))) {
      emit({ type: 'status', text: '(ignored unsafe extraArgs)' });
    } else {
      args.push(...extra);
    }
  }
  const run = runClaude({ prompt, args, cwd, emit });
  if (run === null) {
    cleanup(); // SDK fallback doesn't take images yet
    return sdkChat({ messages, system, options }, emit);
  }
  try {
    const { streamedAny, resultText } = await run;
    emit({ type: 'done', text: streamedAny ? '' : resultText });
  } finally {
    cleanup();
  }
}

// A fast, tool-free single-shot completion — used for prompt autocomplete. No
// tools, no local config: just a quick text continuation from a fast model.
export async function complete({ prompt, system, model }) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--disallowedTools', 'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash', 'Edit', 'Write', 'Task', 'TodoWrite',
    '--setting-sources', '',
    '--model', model || 'haiku',
    '--system-prompt', system || "Continue the user's text briefly. Reply with only the continuation.",
  ];
  let text = '';
  const run = runClaude({
    prompt,
    args,
    cwd: null,
    emit: (e) => {
      if (e.type === 'delta') text += e.text;
    },
  });
  if (run === null) return sdkComplete({ prompt, system, model }); // no CLI → SDK
  const { resultText } = await run;
  return (text || resultText || '').trim();
}

function toolSummary(block) {
  const i = block.input || {};
  if (i.command) return String(i.command).slice(0, 60);
  if (i.file_path) return path.basename(i.file_path);
  if (i.pattern) return i.pattern;
  if (i.url) return i.url;
  return '';
}

// ---------------------------------------------------------------------------
// Fallback: in-process Claude Agent SDK. Only reached when no native/WSL claude
// CLI is resolvable (and we're not a compiled binary, where its bundled cli.js
// is unreachable). The SDK ships its own cli.js and uses your ~/.claude login.

let sdkPromise = null;
function loadSdk() {
  // Optional dependency — absent in lean/compiled installs; import().catch makes
  // that a graceful "no fallback available" rather than a crash.
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk').catch(() => null);
  return sdkPromise;
}

async function sdkChat({ messages, system, options }, emit) {
  const sdk = await loadSdk();
  if (!sdk) throw new Error(lastReason);
  const { query } = sdk;

  const permissionMode = options.permissionMode || 'default';
  const cwd = options.workingDir ? path.resolve(options.workingDir) : os.homedir();
  const writesAllowed = permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions';
  const readonly = new Set(READONLY_TOOLS);
  const canUseTool = async (toolName) =>
    readonly.has(toolName) || writesAllowed
      ? { behavior: 'allow', updatedInput: undefined }
      : { behavior: 'deny', message: `${toolName} blocked — set this agent's permission mode in ChatPanel to enable it.` };

  let streamedAny = false;
  let resultText = '';
  const iterator = query({
    prompt: buildCliPrompt(messages),
    options: {
      cwd,
      permissionMode,
      includePartialMessages: true,
      canUseTool,
      settingSources: options.useLocalConfig === false ? [] : ['user', 'project'],
      systemPrompt: system
        ? { type: 'preset', preset: 'claude_code', append: system }
        : { type: 'preset', preset: 'claude_code' },
      ...(options.model ? { model: options.model } : {}),
      ...(process.env.CHATPANEL_MAX_TURNS ? { maxTurns: Number(process.env.CHATPANEL_MAX_TURNS) } : {}),
    },
  });
  for await (const message of iterator) {
    const r = handleMessage(message, emit, streamedAny);
    if (r.streamed) streamedAny = true;
    if (r.result != null) resultText = r.result;
  }
  emit({ type: 'done', text: streamedAny ? '' : resultText });
}

async function sdkComplete({ prompt, system, model }) {
  const sdk = await loadSdk();
  if (!sdk) throw new Error(lastReason);
  const { query } = sdk;
  let text = '';
  const iterator = query({
    prompt,
    options: {
      cwd: os.homedir(),
      permissionMode: 'default',
      allowedTools: [],
      maxTurns: 1,
      settingSources: [],
      systemPrompt: system || "Continue the user's text briefly. Reply with only the continuation.",
      model: model || 'haiku',
    },
  });
  for await (const message of iterator) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) if (block.type === 'text') text += block.text;
    } else if (message.type === 'result' && message.subtype === 'success' && !text) {
      text = message.result || '';
    }
  }
  return text.trim();
}
