import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCliPrompt } from '../src/engines/prompt.js';

test('CLI prompt labels prior turns as history and the final turn as current', () => {
  const prompt = buildCliPrompt([
    { role: 'user', content: 'tell me about the latest movie obsession' },
    { role: 'assistant', content: 'The latest movie obsession is Toy Story 5.' },
    { role: 'user', content: 'how much money it made?' },
  ], 'Use Movies MCP when relevant.');

  assert.match(prompt, /^Use Movies MCP when relevant\./);
  assert.match(prompt, /Conversation history \(context only; do not answer these prior turns\):/);
  assert.match(prompt, /User: tell me about the latest movie obsession/);
  assert.match(prompt, /Assistant: The latest movie obsession is Toy Story 5\./);
  assert.match(prompt, /Current user message \(answer this message now; use the history above only as context\):\nhow much money it made\?$/);
  assert(!prompt.endsWith('\n\nhow much money it made?'));
});

test('CLI prompt makes short follow-ups unambiguous after a correction', () => {
  const prompt = buildCliPrompt([
    { role: 'user', content: 'tell me about the latest movie obsession' },
    { role: 'assistant', content: 'I assumed you meant Toy Story 5.' },
    { role: 'user', content: 'but i didnt ask question about it!' },
    { role: 'assistant', content: 'You are right; I should clarify.' },
    { role: 'user', content: 'ok continue then' },
  ]);

  assert.match(prompt, /Assistant: You are right; I should clarify\./);
  assert.match(prompt, /---\n\nCurrent user message .*:\nok continue then$/);
});

test('CLI prompt works for a single-turn conversation', () => {
  assert.equal(
    buildCliPrompt([{ role: 'user', content: 'hello' }]),
    'Current user message (answer this message now; use the history above only as context):\nhello',
  );
});
