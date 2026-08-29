// OpenAI + Anthropic wire-format adapters for ChatPanel's local agent engines.
//
// This intentionally implements the text conversation subset shared by coding
// agents. Provider-hosted features (token accounting, stored responses, remote
// function tools, logprobs, etc.) cannot be reproduced by a local CLI runner and
// are rejected when accepting them would produce misleading behavior.

import { randomUUID } from 'node:crypto';

const AGENT_IDS = new Set(['claude', 'codex', 'antigravity', 'pi', 'opencode', 'kiro', 'copilot', 'deepseek']);

export class CompatError extends Error {
  constructor(message, status = 400, param = null) {
    super(message);
    this.status = status;
    this.param = param;
  }
}

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content);
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (typeof part.text === 'string') return part.text;
    if (typeof part.content === 'string') return part.content;
    if (part.type === 'tool_result') return textOf(part.content);
    return '';
  }).filter(Boolean).join('\n');
}

function assertTextContent(content, param) {
  if (content == null || typeof content === 'string') return;
  if (!Array.isArray(content)) throw new CompatError(`${param} must contain text`, 400, param);
  for (const part of content) {
    if (typeof part === 'string') continue;
    const type = part?.type;
    if (part && typeof part === 'object' && (!type || ['text', 'input_text', 'output_text'].includes(type)) && typeof part.text === 'string') continue;
    if (type === 'tool_result') {
      assertTextContent(part.content, param);
      continue;
    }
    throw new CompatError(`${param} contains unsupported non-text content`, 400, param);
  }
}

function normalizeMessages(items = []) {
  return items.map((item) => ({
    role: item?.role === 'assistant' ? 'assistant' : 'user',
    content: textOf(item?.content),
  })).filter((item) => item.content);
}

function resolveTarget(model, chatpanel = {}) {
  const requested = String(model || 'codex').trim() || 'codex';
  const slash = requested.indexOf('/');
  const prefix = slash < 0 ? requested : requested.slice(0, slash);
  const explicitAgent = String(chatpanel.agent || '').trim();
  const agent = explicitAgent || (AGENT_IDS.has(prefix) ? prefix : 'codex');
  if (!AGENT_IDS.has(agent)) throw new CompatError(`Unknown ChatPanel agent "${agent}"`, 400, 'model');

  let engineModel = String(chatpanel.model || '').trim();
  if (!engineModel && slash >= 0 && AGENT_IDS.has(prefix)) engineModel = requested.slice(slash + 1);
  if (!engineModel && !AGENT_IDS.has(requested)) engineModel = requested;

  const permissionMode = chatpanel.permission_mode || chatpanel.permissionMode || 'default';
  if (!['default', 'acceptEdits', 'bypassPermissions'].includes(permissionMode)) {
    throw new CompatError('chatpanel.permission_mode must be default, acceptEdits, or bypassPermissions', 400, 'chatpanel.permission_mode');
  }
  return {
    agent,
    requestedModel: requested,
    options: {
      workingDir: chatpanel.working_dir || chatpanel.workingDir || process.env.CHATPANEL_API_WORKING_DIR || '',
      permissionMode,
      useLocalConfig: chatpanel.use_local_config ?? chatpanel.useLocalConfig ?? true,
      ...(engineModel ? { model: engineModel } : {}),
    },
  };
}

export function parseChatCompletion(body = {}) {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new CompatError('messages must be a non-empty array', 400, 'messages');
  }
  if (body.tools?.length) throw new CompatError('OpenAI tool calling is not supported by the bridge adapter', 400, 'tools');
  for (const message of body.messages) {
    if (!['system', 'developer', 'user', 'assistant'].includes(message?.role)) {
      throw new CompatError(`Unsupported message role "${message?.role || ''}"`, 400, 'messages');
    }
    assertTextContent(message.content, 'messages');
  }
  const system = body.messages
    .filter((m) => m?.role === 'system' || m?.role === 'developer')
    .map((m) => textOf(m.content)).filter(Boolean).join('\n\n');
  const messages = normalizeMessages(body.messages.filter((m) => m?.role !== 'system' && m?.role !== 'developer'));
  if (!messages.length) throw new CompatError('messages must contain user or assistant text', 400, 'messages');
  return { ...resolveTarget(body.model, body.chatpanel), system, messages, stream: body.stream === true };
}

export function parseCompletion(body = {}) {
  if (Array.isArray(body.prompt)) {
    for (const prompt of body.prompt) assertTextContent(prompt, 'prompt');
  } else {
    assertTextContent(body.prompt, 'prompt');
  }
  const prompt = Array.isArray(body.prompt) ? body.prompt.map(textOf).join('\n') : textOf(body.prompt);
  if (!prompt) throw new CompatError('prompt must contain text', 400, 'prompt');
  return {
    ...resolveTarget(body.model, body.chatpanel),
    system: '',
    messages: [{ role: 'user', content: prompt }],
    stream: body.stream === true,
  };
}

export function parseResponse(body = {}) {
  if (body.tools?.length) throw new CompatError('Responses API tool calling is not supported by the bridge adapter', 400, 'tools');
  let input = body.input;
  if (typeof input === 'string') input = [{ role: 'user', content: input }];
  if (!Array.isArray(input) || !input.length) throw new CompatError('input must be a string or non-empty array', 400, 'input');
  assertTextContent(body.instructions, 'instructions');
  for (const item of input) {
    if (!['system', 'developer', 'user', 'assistant'].includes(item?.role)) {
      throw new CompatError('input currently supports only text message items', 400, 'input');
    }
    assertTextContent(item.content, 'input');
  }
  const systemParts = [textOf(body.instructions)];
  for (const item of input) {
    if (item?.role === 'system' || item?.role === 'developer') systemParts.push(textOf(item.content));
  }
  const messages = normalizeMessages(input.filter((item) => item?.role !== 'system' && item?.role !== 'developer'));
  if (!messages.length) throw new CompatError('input must contain user or assistant text', 400, 'input');
  return {
    ...resolveTarget(body.model, body.chatpanel),
    system: systemParts.filter(Boolean).join('\n\n'),
    messages,
    stream: body.stream === true,
  };
}

export function parseAnthropicMessage(body = {}) {
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new CompatError('messages must be a non-empty array', 400, 'messages');
  }
  if (body.tools?.length) throw new CompatError('Anthropic tool use is not supported by the bridge adapter', 400, 'tools');
  assertTextContent(body.system, 'system');
  for (const message of body.messages) {
    if (!['user', 'assistant'].includes(message?.role)) {
      throw new CompatError(`Unsupported message role "${message?.role || ''}"`, 400, 'messages');
    }
    assertTextContent(message.content, 'messages');
  }
  const messages = normalizeMessages(body.messages);
  if (!messages.length) throw new CompatError('messages must contain text', 400, 'messages');
  return {
    ...resolveTarget(body.model, body.chatpanel),
    system: textOf(body.system),
    messages,
    stream: body.stream === true,
  };
}

export function openAIError(error) {
  return {
    error: {
      message: error?.message || String(error),
      type: error instanceof CompatError ? 'invalid_request_error' : 'api_error',
      param: error?.param || null,
      code: null,
    },
  };
}

export function anthropicError(error) {
  return {
    type: 'error',
    error: {
      type: error instanceof CompatError ? 'invalid_request_error' : 'api_error',
      message: error?.message || String(error),
    },
  };
}

const zeroUsage = () => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
const responseUsage = () => ({ input_tokens: 0, input_tokens_details: { cached_tokens: 0 }, output_tokens: 0, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 });

export function createChatCompletion(model, text, { id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000) } = {}) {
  return {
    id, object: 'chat.completion', created, model,
    choices: [{ index: 0, message: { role: 'assistant', content: text, refusal: null }, logprobs: null, finish_reason: 'stop' }],
    usage: zeroUsage(),
  };
}

export function createCompletion(model, text, { id = `cmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000) } = {}) {
  return {
    id, object: 'text_completion', created, model,
    choices: [{ text, index: 0, logprobs: null, finish_reason: 'stop' }],
    usage: zeroUsage(),
  };
}

export function completionStream(model, onWrite, { id = `cmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000) } = {}) {
  const chunk = (text, finish_reason = null) => ({
    id, object: 'text_completion', created, model,
    choices: [{ text, index: 0, logprobs: null, finish_reason }],
  });
  return {
    delta(text) { if (text) onWrite(chunk(text)); },
    done() { onWrite(chunk('', 'stop')); },
  };
}

export function chatCompletionStream(model, onWrite, { id = `chatcmpl-${randomUUID()}`, created = Math.floor(Date.now() / 1000) } = {}) {
  const chunk = (delta, finish_reason = null) => ({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason }],
  });
  let started = false;
  return {
    delta(text) {
      if (!started) { onWrite(chunk({ role: 'assistant', content: '' })); started = true; }
      if (text) onWrite(chunk({ content: text }));
    },
    done() {
      if (!started) onWrite(chunk({ role: 'assistant', content: '' }));
      onWrite(chunk({}, 'stop'));
    },
  };
}

function responseObject(model, text, { id, created, status = 'completed' }) {
  const itemId = `msg_${id.slice(-24)}`;
  return {
    id, object: 'response', created_at: created, status, error: null, incomplete_details: null,
    instructions: null, max_output_tokens: null, model,
    output: status === 'completed' ? [{ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [], logprobs: [] }] }] : [],
    parallel_tool_calls: false, previous_response_id: null, reasoning: { effort: null, summary: null }, store: false,
    temperature: null, text: { format: { type: 'text' } }, tool_choice: 'none', tools: [], top_p: null,
    truncation: 'disabled', usage: status === 'completed' ? responseUsage() : null, user: null, metadata: {},
  };
}

export function createResponse(model, text, { id = `resp_${randomUUID()}`, created = Math.floor(Date.now() / 1000) } = {}) {
  return responseObject(model, text, { id, created });
}

export function responseStream(model, onWrite, { id = `resp_${randomUUID()}`, created = Math.floor(Date.now() / 1000) } = {}) {
  const itemId = `msg_${id.slice(-24)}`;
  let sequence = 0;
  let text = '';
  onWrite({ type: 'response.created', sequence_number: sequence++, response: responseObject(model, '', { id, created, status: 'in_progress' }) });
  onWrite({ type: 'response.in_progress', sequence_number: sequence++, response: responseObject(model, '', { id, created, status: 'in_progress' }) });
  onWrite({ type: 'response.output_item.added', sequence_number: sequence++, output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
  onWrite({ type: 'response.content_part.added', sequence_number: sequence++, item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [], logprobs: [] } });
  return {
    delta(value) {
      if (!value) return;
      text += value;
      onWrite({ type: 'response.output_text.delta', sequence_number: sequence++, item_id: itemId, output_index: 0, content_index: 0, delta: value, logprobs: [] });
    },
    done() {
      onWrite({ type: 'response.output_text.done', sequence_number: sequence++, item_id: itemId, output_index: 0, content_index: 0, text, logprobs: [] });
      const part = { type: 'output_text', text, annotations: [], logprobs: [] };
      onWrite({ type: 'response.content_part.done', sequence_number: sequence++, item_id: itemId, output_index: 0, content_index: 0, part });
      const item = { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
      onWrite({ type: 'response.output_item.done', sequence_number: sequence++, output_index: 0, item });
      onWrite({ type: 'response.completed', sequence_number: sequence++, response: responseObject(model, text, { id, created }) });
    },
  };
}

export function createAnthropicMessage(model, text, { id = `msg_${randomUUID()}` } = {}) {
  return { id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
}

export function anthropicStream(model, onWrite, { id = `msg_${randomUUID()}` } = {}) {
  onWrite('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  onWrite('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  return {
    delta(text) { if (text) onWrite('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }); },
    done() {
      onWrite('content_block_stop', { type: 'content_block_stop', index: 0 });
      onWrite('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } });
      onWrite('message_stop', { type: 'message_stop' });
    },
  };
}
