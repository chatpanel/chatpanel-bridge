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
import os from 'node:os';
import path from 'node:path';
import { resolveClaude, toWslPath, isCompiledBinary } from '../env.js';

const TIMEOUT_MS = Number(process.env.CHATPANEL_CLAUDE_TIMEOUT_MS) || 180_000;
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

// The bridge is stateless, so we replay the conversation as a single prompt.
function buildPrompt(messages) {
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  let prompt = '';
  if (history.length) {
    prompt += 'Conversation so far:\n';
    for (const m of history) prompt += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n\n`;
    prompt += '---\n\n';
  }
  prompt += last ? last.content : '';
  return prompt;
}

// Turn a launch spec + the claude CLI args into a concrete [bin, argv, options]
// for spawn(). `cwd` is the resolved working dir (Windows path on win32), or null
// to use the home directory.
function buildSpawn(spec, args, cwd) {
  if (spec.kind === 'wsl') {
    // Run claude inside WSL's login shell so nvm/etc. PATH resolves it. The
    // `'exec claude "$@"'` + 'chatpanel' ($0) trick passes our args through as a
    // proper argv array — no manual quoting, even for multi-line system prompts.
    const pre = [];
    if (cwd) {
      const wslCwd = toWslPath(cwd);
      if (wslCwd) pre.push('--cd', wslCwd); // else: run in WSL home
    }
    const argv = [...pre, '-e', 'bash', '-lic', 'exec claude "$@"', 'chatpanel', ...args];
    return ['wsl.exe', argv, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true }];
  }

  const spawnCwd = cwd || os.homedir();
  const opts = { cwd: spawnCwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, windowsHide: true };
  if (spec.kind === 'script') {
    // Run cli.js with the interpreter already running the bridge (node/bun).
    return [process.execPath, [spec.script, ...args], opts];
  }
  // kind === 'native' — direct executable (.exe / mac+linux binary), or a .cmd
  // shim via the shell on Windows.
  return [spec.bin, args, { ...opts, shell: !!spec.shell }];
}

// Spawn claude (however it resolves) and stream its stream-json output via
// `emit`. Resolves with { streamedAny, resultText } once it closes 0. Returns
// null (no spawn) when claude can't be resolved, so the caller can fall back.
function runClaude({ prompt, args, cwd, emit }) {
  const spec = resolveClaude();
  if (!spec) return null;
  const [bin, argv, opts] = buildSpawn(spec, args, cwd);

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

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Claude Code timed out after ${Math.round(TIMEOUT_MS / 1000)}s.`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => {
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
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start claude (${bin}): ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ streamedAny, resultText });
      else reject(new Error(`Claude Code exited ${code}: ${stderr.trim().split('\n').pop() || 'failed'}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Map one stream-json message to emit() calls. Returns { streamed, result }.
// The CLI's stream-json mirrors the SDK message shapes.
function handleMessage(msg, emit, alreadyStreamed) {
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

export async function chat({ messages, system, options }, emit) {
  const permissionMode = options.permissionMode || 'default';
  // Explicit project dir, else null → CLI runs in home (or WSL home).
  const cwd = options.workingDir ? path.resolve(options.workingDir) : null;

  const args = ['--print', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];

  // Gate writes/shell behind the chosen mode; otherwise restrict to read-only
  // tools so headless runs never block on an approval prompt.
  if (permissionMode === 'bypassPermissions') args.push('--permission-mode', 'bypassPermissions');
  else if (permissionMode === 'acceptEdits') args.push('--permission-mode', 'acceptEdits');
  else args.push('--allowedTools', ...READONLY_TOOLS);

  // Native Claude Code behavior; append the user's own system prompt if they set
  // one (no ChatPanel persona injected).
  if (system) args.push('--append-system-prompt', system);
  if (options.model) args.push('--model', options.model);
  // Default loads your ~/.claude + project settings (skills, MCP, CLAUDE.md).
  // "Use my local skills & config" off → run clean.
  if (options.useLocalConfig === false) args.push('--setting-sources', '');

  const run = runClaude({ prompt: buildPrompt(messages), args, cwd, emit });
  if (run === null) return sdkChat({ messages, system, options }, emit); // no CLI → SDK
  const { streamedAny, resultText } = await run;
  emit({ type: 'done', text: streamedAny ? '' : resultText });
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
    prompt: buildPrompt(messages),
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
