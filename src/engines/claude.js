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

let sdkPromise = null;
function loadSdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk').catch(() => null);
  return sdkPromise;
}

export async function available() {
  const sdk = await loadSdk();
  if (!sdk) {
    return { ok: false, reason: 'Agent SDK not installed (npm i in bridge/)' };
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    // Not fatal — the SDK can use your local Claude Code login.
    return { ok: true };
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

function toolSummary(block) {
  const i = block.input || {};
  if (i.command) return String(i.command).slice(0, 60);
  if (i.file_path) return path.basename(i.file_path);
  if (i.pattern) return i.pattern;
  if (i.url) return i.url;
  return '';
}
