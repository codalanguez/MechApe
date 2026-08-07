/**
 * test-openrouter.js — unit tests for the OpenRouter adapter boundary.
 *
 * `npm test`. No framework, no network: exercises buildChatPayload (privacy
 * routing, option remapping, routing variants, cache markers) and sseToNdjson
 * (delta/reasoning/usage/error translation, keepalives, split chunks, type
 * coercion) — the two pieces most likely to break silently against a remote
 * API. Exits non-zero on any failure.
 */
const assert = require('assert');
const { buildChatPayload, sseToNdjson, looksLikeNoToolSupport } = require('../lib/openrouter');

/* Tests queue here and run sequentially at the bottom of the file, so the
 * output order matches the declaration order. */
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

const sys = [{ role: 'system', content: 'You edit manuscripts.' }, { role: 'user', content: 'hi' }];

test('privacy routing: data_collection deny is on by default', () => {
  const p = buildChatPayload({ model: 'openrouter:deepseek/deepseek-chat', messages: sys, options: {} });
  assert.deepStrictEqual(p.provider, { data_collection: 'deny' });
  assert.deepStrictEqual(p.usage, { include: true });
});

test('options remap: num_predict→max_tokens, repeat_penalty→repetition_penalty, local knobs dropped', () => {
  const p = buildChatPayload({
    model: 'openrouter:x/y', messages: sys,
    options: { num_predict: 512, repeat_penalty: 1.1, num_ctx: 16384, keep_alive: '5m', mirostat: 2, temperature: 0.8 },
  });
  assert.strictEqual(p.max_tokens, 512);
  assert.strictEqual(p.repetition_penalty, 1.1);
  assert.strictEqual(p.temperature, 0.8);
  for (const k of ['num_ctx', 'keep_alive', 'mirostat', 'num_predict', 'repeat_penalty', 'or_route']) {
    assert.ok(!(k in p), `${k} must not reach the API body`);
  }
});

test('or_route appends a variant suffix, but never onto an existing variant', () => {
  const a = buildChatPayload({ model: 'openrouter:mistralai/mistral-large', messages: sys, options: { or_route: 'floor' } });
  const b = buildChatPayload({ model: 'openrouter:deepseek/deepseek-chat:free', messages: sys, options: { or_route: 'floor' } });
  assert.strictEqual(a.model, 'mistralai/mistral-large:floor');
  assert.strictEqual(b.model, 'deepseek/deepseek-chat:free');
});

test('cache markers only on cacheable providers, system content preserved byte-for-byte', () => {
  const a = buildChatPayload({ model: 'openrouter:anthropic/claude-sonnet-4.5', messages: sys, options: {} });
  const b = buildChatPayload({ model: 'openrouter:deepseek/deepseek-chat', messages: sys, options: {} });
  assert.deepStrictEqual(a.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.strictEqual(a.messages[0].content[0].text, sys[0].content);
  assert.strictEqual(typeof b.messages[0].content, 'string');
});

function streamOf(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
}

async function collect(chunks) {
  const reader = sseToNdjson(streamOf(chunks)).getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value); }
  return out.trim().split('\n').map(l => JSON.parse(l));
}

test('stream: deltas, reasoning, keepalives, split chunks, DONE', async () => {
  const events = await collect([
    ': OPENROUTER PROCESSING\n\n',
    'data: {"choices":[{"delta":{"reasoning":"think. "}}]}\n\n',
    'data: {"choices":[{"delta":{"cont',                       // split mid-JSON
    'ent":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
  ]);
  assert.deepStrictEqual(events, [
    { message: { thinking: 'think. ' } },
    { message: { content: 'Hel' } },
    { message: { content: 'lo' } },
    { done: true },
  ]);
});

test('stream: usage is emitted with hard numeric coercion', async () => {
  const events = await collect([
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":"<img onerror=x>","completion_tokens":"12","total_tokens":12,"cost":"0.5"}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const usage = events.find(e => e.usage)?.usage;
  assert.deepStrictEqual(usage, { promptTokens: 0, completionTokens: 12, cost: null },
    'provider-supplied strings must never survive the boundary');
});

test('stream: provider errors become Ollama-shaped {error} lines', async () => {
  const events = await collect(['data: {"error":{"message":"provider hiccup"}}\n\ndata: [DONE]\n\n']);
  assert.deepStrictEqual(events[0], { error: 'provider hiccup' });
});

test('stream: a newline-less oversized line fails loudly instead of buffering forever', async () => {
  const events = await collect(['data: ' + 'x'.repeat(1100 * 1024)]); // > MAX_SSE_LINE, no \n
  assert.strictEqual(events.length, 1, 'stream must terminate after the error');
  assert.match(events[0].error, /oversized/i);
});

test('stream: a usage chunk without total_tokens emits no usage event', async () => {
  const events = await collect(['data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":5}}\n\ndata: [DONE]\n\n']);
  assert.deepStrictEqual(events, [{ done: true }]);
});

/* ---- tool calling ---- */

test('looksLikeNoToolSupport: a model that cannot call tools is a fallback, not an error', () => {
  // OpenRouter's status for this varies by provider, so it is matched on the
  // message. Getting it wrong in the permissive direction would swallow real
  // errors; in the strict direction it just errors at someone who asked a
  // question, which is why the pattern is narrow and the status list short.
  assert.strictEqual(looksLikeNoToolSupport(404, '{"error":{"message":"No endpoints found that support tool use"}}'), true);
  assert.strictEqual(looksLikeNoToolSupport(400, 'model does not support function calling'), true);
  assert.strictEqual(looksLikeNoToolSupport(422, 'tool_choice is not supported'), true);
});

test('looksLikeNoToolSupport: real failures still surface', () => {
  assert.strictEqual(looksLikeNoToolSupport(401, 'invalid api key'), false, 'a bad key must not look like a tool problem');
  assert.strictEqual(looksLikeNoToolSupport(402, 'insufficient credits'), false);
  assert.strictEqual(looksLikeNoToolSupport(500, 'upstream tool error'), false, 'a 500 is an outage, not a capability');
  assert.strictEqual(looksLikeNoToolSupport(400, 'context length exceeded'), false);
});

test('a tool pre-pass keeps the privacy routing of the streamed turn', () => {
  // The pre-pass must not be routed under looser rules than the chat it
  // precedes: a data_collection=deny conversation stays deny throughout.
  const p = buildChatPayload({
    model: 'openrouter:anthropic/claude-sonnet-4',
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    options: { or_route: 'floor' },
  });
  assert.strictEqual(p.provider.data_collection, 'deny');
  assert.ok(p.model.endsWith(':floor'), 'routing variant should survive into the tool turn');
});

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall openrouter adapter tests passed');
})();
