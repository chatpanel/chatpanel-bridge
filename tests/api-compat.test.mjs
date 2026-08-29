import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompatError,
  anthropicStream,
  chatCompletionStream,
  completionStream,
  createAnthropicMessage,
  createChatCompletion,
  createCompletion,
  createResponse,
  parseAnthropicMessage,
  parseChatCompletion,
  parseCompletion,
  parseResponse,
  responseStream,
} from '../src/api-compat.js';

test('OpenAI chat messages map system instructions and codex model selection', () => {
  const parsed = parseChatCompletion({
    model: 'codex/gpt-5.5',
    messages: [
      { role: 'developer', content: 'Be concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
    ],
    chatpanel: { working_dir: '/tmp/project', permission_mode: 'acceptEdits' },
  });
  assert.equal(parsed.agent, 'codex');
  assert.equal(parsed.requestedModel, 'codex/gpt-5.5');
  assert.equal(parsed.options.model, 'gpt-5.5');
  assert.equal(parsed.options.workingDir, '/tmp/project');
  assert.equal(parsed.options.permissionMode, 'acceptEdits');
  assert.equal(parsed.system, 'Be concise.');
  assert.deepEqual(parsed.messages, [{ role: 'user', content: 'Hello' }]);
});

test('plain OpenAI model ids use Codex and pass through as its model override', () => {
  const parsed = parseChatCompletion({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'Hi' }] });
  assert.equal(parsed.agent, 'codex');
  assert.equal(parsed.options.model, 'gpt-5.5');
});

test('legacy OpenAI completions map prompt text to a Codex turn', () => {
  const parsed = parseCompletion({ model: 'codex', prompt: 'Complete this' });
  assert.equal(parsed.agent, 'codex');
  assert.deepEqual(parsed.messages, [{ role: 'user', content: 'Complete this' }]);
});

test('Responses input accepts strings and structured text parts', () => {
  const simple = parseResponse({ model: 'codex', instructions: 'Answer directly.', input: 'Status?' });
  assert.equal(simple.system, 'Answer directly.');
  assert.deepEqual(simple.messages, [{ role: 'user', content: 'Status?' }]);

  const structured = parseResponse({
    model: 'codex',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect this.' }] }],
  });
  assert.equal(structured.messages[0].content, 'Inspect this.');
});

test('Anthropic system blocks and messages map to the shared agent shape', () => {
  const parsed = parseAnthropicMessage({
    model: 'codex',
    system: [{ type: 'text', text: 'Use plain language.' }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  });
  assert.equal(parsed.agent, 'codex');
  assert.equal(parsed.system, 'Use plain language.');
  assert.deepEqual(parsed.messages, [{ role: 'user', content: 'Hello' }]);
});

test('provider tool calling is rejected explicitly', () => {
  assert.throws(
    () => parseChatCompletion({ model: 'codex', messages: [{ role: 'user', content: 'Hi' }], tools: [{ type: 'function' }] }),
    (error) => error instanceof CompatError && error.param === 'tools',
  );
  assert.throws(
    () => parseResponse({ model: 'codex', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/a.png' }] }] }),
    (error) => error instanceof CompatError && error.param === 'input',
  );
});

test('non-streaming response factories use provider-native envelopes', () => {
  const chat = createChatCompletion('codex', 'hello', { id: 'chatcmpl-test', created: 1 });
  assert.equal(chat.object, 'chat.completion');
  assert.equal(chat.choices[0].message.content, 'hello');

  const completion = createCompletion('codex', 'hello', { id: 'cmpl-test', created: 1 });
  assert.equal(completion.object, 'text_completion');
  assert.equal(completion.choices[0].text, 'hello');

  const response = createResponse('codex', 'hello', { id: 'resp_test', created: 1 });
  assert.equal(response.object, 'response');
  assert.equal(response.output[0].content[0].text, 'hello');

  const anthropic = createAnthropicMessage('codex', 'hello', { id: 'msg_test' });
  assert.equal(anthropic.type, 'message');
  assert.equal(anthropic.content[0].text, 'hello');
});

test('OpenAI chat stream emits role, text, and stop chunks', () => {
  const events = [];
  const stream = chatCompletionStream('codex', (event) => events.push(event), { id: 'chatcmpl-test', created: 1 });
  stream.delta('hel');
  stream.delta('lo');
  stream.done();
  assert.deepEqual(events.map((event) => event.choices[0].delta.content), ['', 'hel', 'lo', undefined]);
  assert.equal(events.at(-1).choices[0].finish_reason, 'stop');
});

test('legacy OpenAI completion stream emits text and stop chunks', () => {
  const events = [];
  const stream = completionStream('codex', (event) => events.push(event), { id: 'cmpl-test', created: 1 });
  stream.delta('hello');
  stream.done();
  assert.equal(events[0].choices[0].text, 'hello');
  assert.equal(events[1].choices[0].finish_reason, 'stop');
});

test('Responses stream emits the standard text lifecycle', () => {
  const events = [];
  const stream = responseStream('codex', (event) => events.push(event), { id: 'resp_test', created: 1 });
  stream.delta('hello');
  stream.done();
  assert.deepEqual(events.map((event) => event.type), [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
});

test('Anthropic stream emits the message and content-block lifecycle', () => {
  const events = [];
  const stream = anthropicStream('codex', (name, event) => events.push([name, event]), { id: 'msg_test' });
  stream.delta('hello');
  stream.done();
  assert.deepEqual(events.map(([name]) => name), [
    'message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
});
