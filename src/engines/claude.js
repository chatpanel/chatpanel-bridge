// Claude Code engine — drives the Claude Code CLI (`claude --print`) directly,
// the SAME way the Codex engine drives `codex exec`. No Agent SDK, no bundled
// cli.js, no native `sharp` dependency — so it works in any environment that has
// `claude` on PATH (npm install, native installer, or `npx`), and there's nothing
// to resolve inside a compiled binary (the old "/$bunfs/root/cli.js" failure).
//
// It uses your *local* Claude Code login. By default the agent can READ your code
// (Read/Grep/Glob/WebFetch/…) but cannot write or run shell commands unless the
// agent's permissionMode is 'acceptEdits' or 'bypassPermissions' in ChatPanel
// Settings. The working directory comes from the agent config.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { findAgentBin } from '../env.js';

const TIMEOUT_MS = Number(process.env.CHATPANEL_CLAUDE_TIMEOUT_MS) || 180_000;
// Read-only tools allowed without approval in headless mode; writes/shell are
// gated behind the agent's permission mode.
const READONLY_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task'];

let installed = false;
let lastProbe = 0;
export async function available() {
  // Availability = "is claude findable on PATH" (mirrors the codex engine), NOT
  // "does `claude --version` exit 0" (which fails when it just needs login).
  if (!installed && Date.now() - lastProbe > 4000) {
    lastProbe = Date.now();
    try {
      installed = !!findAgentBin('claude');
    } catch {
      installed = false;
    }
  }
  return installed
    ? { ok: true }
    : { ok: false, reason: 'Claude Code not found on PATH. Install it (npm i -g @anthropic-ai/claude-code) and run `claude` once to log in.' };
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

// Spawn `claude` and stream its stream-json output, forwarding events via `emit`.
// `extraArgs` lets complete() run a tool-free single shot. Resolves with the final
// result text once the process closes 0.
function runClaude({ prompt, args, cwd, emit }) {
  const bin = findAgentBin('claude') || 'claude';
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
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
      reject(e);
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
  const cwd = options.workingDir ? path.resolve(options.workingDir) : os.homedir();

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

  const { streamedAny, resultText } = await runClaude({ prompt: buildPrompt(messages), args, cwd, emit });
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
  const { resultText } = await runClaude({
    prompt,
    args,
    cwd: os.homedir(),
    emit: (e) => {
      if (e.type === 'delta') text += e.text;
    },
  });
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
