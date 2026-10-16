import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicModelClient, AnthropicModelError } from '../dist/index.js';
import { loadConversations } from './support/conversations.mjs';
const turn = () => loadConversations().find(item => item.id === 'dialogue-ambiguous-time').turns[0];
const options = { apiKey: 'test-placeholder-claude-key', model: 'claude-sonnet-5-5', effort: 'medium' };
const envelope = proposal => ({ type: 'message', role: 'assistant', stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: JSON.stringify(proposal) }] });

test('Claude sends one bounded structured request with effort and validates every conversation fixture locally', async () => {
  let calls = 0;
  for (const fixture of loadConversations()) for (const { input, proposal } of fixture.turns) {
    const client = createAnthropicModelClient({ ...options, fetch: async (url, init) => {
      calls++; assert.equal(url, 'https://api.anthropic.com/v1/messages'); assert.equal(init.redirect, 'error');
      assert.equal(init.headers['x-api-key'], options.apiKey); assert.equal(init.headers['anthropic-version'], '2023-06-01');
      const body = JSON.parse(init.body); assert.equal(body.output_config.effort, 'medium');
      assert.deepEqual(body.messages, [{ role: 'user', content: JSON.stringify(input) }]);
      assert.equal(body.tools, undefined); assert.equal(body.stream, false);
      assert.deepEqual(body.thinking, { type: 'adaptive' });
      const schema = body.output_config.format.schema;
      let unions = 0, optional = 0;
      const walk = value => {
        if (!value || typeof value !== 'object') return;
        assert.equal(value.minimum, undefined); assert.equal(value.maximum, undefined);
        if (value.anyOf) unions++;
        if (value.properties) { assert.equal(value.additionalProperties, false); optional += Object.keys(value.properties).filter(key => !value.required?.includes(key)).length; }
        Object.values(value).forEach(child => Array.isArray(child) ? child.forEach(walk) : walk(child));
      };
      walk(schema); assert.ok(unions <= 16); assert.ok(optional <= 24);
      return Response.json(envelope(proposal));
    } });
    assert.deepEqual(await client.generate(input, new AbortController().signal), proposal);
  }
  assert.ok(calls > 1);
});

for (const [name, mutate, code] of [
  ['refusal', value => ({ ...value, stop_reason: 'refusal' }), 'refused'],
  ['truncation', value => ({ ...value, stop_reason: 'max_tokens' }), 'incomplete'],
  ['tool call', value => ({ ...value, content: [{ type: 'tool_use', name: 'book' }] }), 'invalid_response'],
  ['schema violation', value => ({ ...value, content: [{ type: 'text', text: '{"candidate":{"action":"invented"}}' }] }), 'invalid_response'],
]) test(`Claude rejects ${name} without retries or raw diagnostics`, async () => {
  let requests = 0; const { input, proposal } = turn();
  const client = createAnthropicModelClient({ ...options, fetch: async () => { requests++; return Response.json(mutate(envelope(proposal))); } });
  await assert.rejects(client.generate(input, new AbortController().signal), error => error instanceof AnthropicModelError && error.code === code);
  assert.equal(requests, 1);
});

test('Claude sanitizes HTTP/network failures and honors cancellation and timeout', async () => {
  const { input } = turn();
  const http = createAnthropicModelClient({ ...options, fetch: async () => new Response('test-placeholder-private-key in provider error', { status: 401 }) });
  await assert.rejects(http.generate(input, new AbortController().signal), error => error.status === 401 && !String(error).includes('private-key'));
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(http.generate(input, cancelled.signal), error => error.code === 'cancelled');
  const stalled = createAnthropicModelClient({ ...options, timeoutMs: 10, fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private abort reason')))) });
  await assert.rejects(stalled.generate(input, new AbortController().signal), error => error.code === 'timeout');
  const network = createAnthropicModelClient({ ...options, fetch: async () => { throw new Error('private failure'); } });
  await assert.rejects(network.generate(input, new AbortController().signal), error => error.code === 'request_failed' && !String(error).includes('private failure'));
});
