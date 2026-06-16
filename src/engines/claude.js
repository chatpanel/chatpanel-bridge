// Claude Code engine — embeds the Claude Agent SDK using your *local* Claude
// Code login (or ANTHROPIC_API_KEY). It streams text deltas and surfaces tool
// use so the extension can show what the agent is doing.
//
// By default the agent can READ your code (Read/Grep/Glob/WebFetch) but cannot
// write or run shell commands unless the agent's permissionMode is set to
// 'acceptEdits' or 'bypassPermissions' in ChatPanel Settings. The working
// directory comes from the agent config (defaults to the bridge's cwd).

import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { findAgentBin, isCompiledBinary } from '../env.js';

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk').catch(() => null);
  return sdkPromise;
}

// Where the Claude Code CLI lives. The SDK ships a bundled cli.js, but inside a
// compiled binary that file is on a virtual FS that child processes can't reach
// (it fails on Windows as "B:\~BUN\cli.js"). So in a binary we point the SDK at
// the user's INSTALLED Claude Code instead — preferring the real cli.js next to
// the npm shim (modern Node won't spawn a .cmd directly).
function claudeExecutable() {
  if (process.env.CHATPANEL_CLAUDE_PATH) return process.env.CHATPANEL_CLAUDE_PATH;
  if (!isCompiledBinary()) return undefined; // under node/bun the bundled cli.js works
  const bin = findAgentBin('claude');
  if (!bin) return undefined;
  const dir = path.dirname(bin);
  // The npm install ships cli.js; the native installer ships cli-wrapper.cjs
  // (a JS entry next to a platform binary). Prefer either runnable JS entry over
  // the native `claude` binary, since the SDK runs it with its own JS runtime.
  const pkgDirs = [
    path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code'),
    path.join(dir, '..', 'lib', 'node_modules', '@anthropic-ai', 'claude-code'),
    // npm global on macOS/Homebrew symlinks bin/claude → ../lib/node_modules/...,
    // so dir is already the package's own bin/ in the native install.
    path.join(dir, '..'),
  ];
  for (const p of pkgDirs) {
    for (const entry of ['cli.js', 'cli-wrapper.cjs']) {
      const c = path.join(p, entry);
      if (existsSync(c)) return c;
    }
  }
  return bin;
}

export async function available() {
  const sdk = await loadSdk();
  if (!sdk) {
    return { ok: false, reason: 'Agent SDK not installed (npm i in bridge/)' };
  }
  // In a compiled binary the bundled CLI is unreachable, so Claude Code must be
  // installed locally. (Under node/bun the bundled CLI works, so this is skipped.)
  if (isCompiledBinary() && !process.env.CHATPANEL_CLAUDE_PATH && !findAgentBin('claude')) {
    return {
      ok: false,
      reason: 'Claude Code not found. Install it (npm i -g @anthropic-ai/claude-code), or run the bridge with `npx @chatpanel/bridge`.',
    };
  }
  return { ok: true };
}

const READONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task']);

// Build a single prompt that carries the conversation history. The bridge is
// stateless, so we replay the chat each turn.
function buildPrompt(messages) {
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  let prompt = '';
  if (history.length) {
    prompt += 'Conversation so far:\n';
    for (const m of history) {
      prompt += `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}\n\n`;
    }
    prompt += '---\n\n';
  }
  prompt += last ? last.content : '';
  return prompt;
}

export async function chat({ messages, system, options }, emit) {
  const sdk = await loadSdk();
  if (!sdk) throw new Error('Claude Agent SDK not installed. Run `npm install` in bridge/.');
  const { query } = sdk;

  const permissionMode = options.permissionMode || 'default';
  // No project configured → a neutral cwd, so the agent doesn't fixate on
  // whatever directory the bridge happens to be running in.
  const cwd = options.workingDir ? path.resolve(options.workingDir) : os.homedir();
  const writesAllowed = permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions';

  // Approve read-only tools always; gate writes/shell behind the chosen mode.
  const canUseTool = async (toolName) => {
    if (READONLY_TOOLS.has(toolName) || writesAllowed) return { behavior: 'allow', updatedInput: undefined };
    return { behavior: 'deny', message: `${toolName} blocked — set this agent's permission mode to acceptEdits/bypassPermissions in ChatPanel to enable it.` };
  };

  let streamedAny = false;
  let resultText = '';

  const iterator = query({
    prompt: buildPrompt(messages),
    options: {
      cwd,
      permissionMode,
      includePartialMessages: true,
      canUseTool,
      // Default: load your ~/.claude + project settings so your skills, MCP
      // servers and CLAUDE.md apply. Turn the agent's "Use my local skills &
      // config" off to run clean.
      settingSources: options.useLocalConfig === false ? [] : ['user', 'project'],
      // Native Claude Code system prompt. Only append the user's OWN system
      // prompt if they set one — no ChatPanel persona is injected, so the agent
      // is exactly as capable as it is in the terminal.
      systemPrompt: system
        ? { type: 'preset', preset: 'claude_code', append: system }
        : { type: 'preset', preset: 'claude_code' },
      ...(options.model ? { model: options.model } : {}),
      ...(claudeExecutable() ? { pathToClaudeCodeExecutable: claudeExecutable() } : {}),
      ...(process.env.CHATPANEL_MAX_TURNS ? { maxTurns: Number(process.env.CHATPANEL_MAX_TURNS) } : {}),
    },
  });

  for await (const message of iterator) {
    if (message.type === 'stream_event') {
      const ev = message.event;
      if (ev?.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') {
          streamedAny = true;
          emit({ type: 'delta', text: ev.delta.text });
        } else if (ev.delta?.type === 'thinking_delta') {
          // Extended thinking — stream the reasoning text to the panel.
          emit({ type: 'reasoning', text: ev.delta.thinking || '' });
        }
      }
    } else if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use') {
          emit({ type: 'tool', name: block.name, summary: toolSummary(block) });
        } else if (block.type === 'text' && !streamedAny) {
          // Partials were unavailable — stream the whole block.
          streamedAny = true;
          emit({ type: 'delta', text: block.text });
        }
      }
    } else if (message.type === 'result') {
      if (message.subtype === 'success') resultText = message.result || '';
      else if (message.subtype !== 'success') {
        emit({ type: 'status', text: `(${message.subtype})` });
      }
    }
  }

  emit({ type: 'done', text: streamedAny ? '' : resultText });
}

// A fast, tool-free single-shot completion — used for prompt autocomplete. No
// claude_code preset, no tools, no local config: just a quick text continuation
// from a fast model (Haiku by default). Returns the completion string.
export async function complete({ prompt, system, model }) {
  const sdk = await loadSdk();
  if (!sdk) throw new Error('Claude Agent SDK not installed.');
  const { query } = sdk;
  let text = '';
  const iterator = query({
    prompt,
    options: {
      cwd: os.homedir(),
      permissionMode: 'default',
      allowedTools: [], // no tools — pure text completion
      maxTurns: 1,
      settingSources: [], // skip CLAUDE.md / MCP for a tiny completion
      systemPrompt: system || "Continue the user's text briefly. Reply with only the continuation.",
      model: model || 'haiku',
      ...(claudeExecutable() ? { pathToClaudeCodeExecutable: claudeExecutable() } : {}),
    },
  });
  for await (const message of iterator) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'text') text += block.text;
      }
    } else if (message.type === 'result' && message.subtype === 'success' && !text) {
      text = message.result || '';
    }
  }
  return text.trim();
}

function toolSummary(block) {
  const i = block.input || {};
  if (i.command) return String(i.command).slice(0, 60);
  if (i.file_path) return path.basename(i.file_path);
  if (i.pattern) return i.pattern;
  if (i.url) return i.url;
  return '';
}
