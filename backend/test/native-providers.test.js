import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../src/security/credentials.js';
import { prepareProviderRequest, executeProviderRequest } from '../src/providers/index.js';
import { anthropicRequest, anthropicUsage } from '../src/providers/anthropic.js';
import { geminiRequest, geminiUsage } from '../src/providers/gemini.js';
import { routeForModel } from '../src/services/routing.js';

const config = { encryptionKey: randomBytes(32) };
const input = { model: 'test-model', messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Hello' }] };
const tools = [{ type: 'function', function: { name: 'weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
function plan(type, body = input, path = '/chat/completions', method = 'POST', signal) {
  const assignment = { api_type: type, api_url: type === 'GEMINI' ? 'https://gemini.example/v1beta' : 'https://anthropic.example/v1', encrypted_api_key: encrypt('native-secret', config.encryptionKey) };
  return prepareProviderRequest(assignment, { url: path, method, get: name => name === 'content-type' ? 'application/json' : name === 'authorization' ? 'Bearer pak_client-secret' : undefined }, Buffer.from(JSON.stringify(body)), config, signal);
}
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const anthMessage = { id: 'msg_test', model: 'test-model', content: [{ type: 'text', text: 'Hi!' }], stop_reason: 'end_turn', usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 } };
const gemMessage = { responseId: 'gem_response', modelVersion: 'test-model', candidates: [{ content: { role: 'model', parts: [{ text: 'Hi!' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16, cachedContentTokenCount: 3 } };
function eventStream(events, bytewise = false) {
  const text = events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({ start(controller) {
    if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const parseStream = text => text.split('\n\n').filter(Boolean).map(line => line.slice(6)).map(value => value === '[DONE]' ? value : JSON.parse(value));

test('native authentication, URLs, message roles and generation settings are translated', () => {
  const body = { ...input, max_completion_tokens: 123, temperature: 0.5, top_p: 0.8, stop: ['end'] };
  const anthropic = plan('ANTHROPIC', body), gemini = plan('GEMINI', { ...body, stream: true });
  assert.equal(String(anthropic.url), 'https://anthropic.example/v1/messages');
  assert.equal(anthropic.init.headers.get('x-api-key'), 'native-secret');
  assert.equal(anthropic.init.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(gemini.init.headers.get('x-goog-api-key'), 'native-secret');
  for (const p of [anthropic, gemini]) { assert.equal(p.init.headers.get('authorization'), null); assert.equal(p.init.redirect, 'manual'); assert(!String(p.url).includes('native-secret')); }
  assert.equal(String(gemini.url), 'https://gemini.example/v1beta/models/test-model:streamGenerateContent?alt=sse');
  const a = JSON.parse(anthropic.init.body), g = JSON.parse(gemini.init.body);
  assert.deepEqual(a.system, [{ type: 'text', text: 'Be brief' }]); assert.equal(a.max_tokens, 123); assert.equal(a.messages[0].role, 'user');
  assert.deepEqual(g.systemInstruction, { parts: [{ text: 'Be brief' }] }); assert.equal(g.generationConfig.maxOutputTokens, 123);
});

test('Gemini drops store before validation for streamed and non-streamed requests', () => {
  for (const stream of [false, true]) for (const store of [false, true, null]) {
    const body = { ...input, stream, stream_options: { include_usage: true }, store };
    const original = structuredClone(body);
    const prepared = plan('GEMINI', body);
    assert.deepEqual(JSON.parse(prepared.init.body), JSON.parse(plan('GEMINI', { ...input, stream, stream_options: { include_usage: true } }).init.body));
    assert.equal(Object.hasOwn(JSON.parse(prepared.init.body), 'store'), false);
    geminiRequest(body);
    assert.deepEqual(body, original);
    assert.throws(() => plan('GEMINI', { ...body, logprobs: true }), { code: 'unsupported_native_request' });
  }
  assert.throws(() => plan('ANTHROPIC', { ...input, store: false }), { code: 'unsupported_native_request' });
});

test('function tool history, tool choice and image input are mapped', () => {
  const body = { ...input, tools, tool_choice: { type: 'function', function: { name: 'weather' } }, messages: [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_one', type: 'function', function: { name: 'weather', arguments: '{"city":"Berlin"}' }, extra_content: { google: { thought_signature: 'opaque-signature' } } }] },
    { role: 'tool', tool_call_id: 'call_one', content: '{"temperature":20}' }
  ] };
  const a = anthropicRequest(body), g = geminiRequest(body);
  assert.equal(a.messages[0].content[0].source.media_type, 'image/png');
  assert.deepEqual(a.messages[1].content[0].input, { city: 'Berlin' });
  assert.equal(a.messages[2].content[0].tool_use_id, 'call_one');
  assert.equal(a.tool_choice.type, 'tool'); assert.equal(a.tools[0].input_schema.type, 'object');
  assert.equal(g.contents[0].parts[0].inlineData.mimeType, 'image/png');
  assert.equal(g.contents[1].parts[0].thoughtSignature, 'opaque-signature');
  assert.deepEqual(g.contents[2].parts[0].functionResponse, { name: 'weather', response: { temperature: 20 } });
  assert.deepEqual(g.toolConfig.functionCallingConfig, { mode: 'ANY', allowedFunctionNames: ['weather'] });
});

test('native unsupported endpoints, options, model paths and dangling tool results fail before fetch', () => {
  for (const type of ['ANTHROPIC','GEMINI']) {
    assert.throws(() => plan(type, input, '/responses'), { code: 'unsupported_provider_endpoint' });
    assert.throws(() => plan(type, { ...input, model: '../escape' }), { status: 400 });
    assert.throws(() => plan(type, { ...input, logprobs: true }), { status: 400 });
    assert.throws(() => plan(type, { ...input, n: 2 }), { status: 400 });
    assert.throws(() => plan(type, { ...input, messages: [{ role: 'tool', tool_call_id: 'missing', content: 'oops' }] }), { status: 400 });
  }
  assert.throws(() => plan('ANTHROPIC', { ...input, response_format: { type: 'json_object' } }), { status: 400 });
  assert.throws(() => plan('GEMINI', { ...input, parallel_tool_calls: false }), { status: 400 });
});

test('native paginated model lists are normalized and all pages use native credentials', async () => {
  for (const type of ['ANTHROPIC','GEMINI']) {
    let count = 0;
    const response = await executeProviderRequest(plan(type, {}, '/models', 'GET'), async (url, init) => {
      assert.equal(init.headers.get(type === 'ANTHROPIC' ? 'x-api-key' : 'x-goog-api-key'), 'native-secret');
      if (++count === 1) return json(type === 'ANTHROPIC' ? { data: [{ id: 'model-a', created_at: '2025-01-01T00:00:00Z' }], has_more: true, last_id: 'model-a' } : { models: [{ name: 'models/model-a' }], nextPageToken: 'page-2' });
      assert.equal(url.searchParams.get(type === 'ANTHROPIC' ? 'after_id' : 'pageToken'), type === 'ANTHROPIC' ? 'model-a' : 'page-2');
      return json(type === 'ANTHROPIC' ? { data: [{ id: 'model-b' }], has_more: false } : { models: [{ name: 'models/model-b' }] });
    });
    const value = await response.json(); assert.equal(value.object, 'list'); assert.deepEqual(value.data.map(m => m.id), ['model-a','model-b']); assert.equal(count, 2);
  }
});

test('native errors preserve status and retry headers without reflecting credentials or prompts', async () => {
  for (const type of ['ANTHROPIC','GEMINI']) {
    const response = await executeProviderRequest(plan(type), async () => json({ error: { message: 'native-secret prompt-secret', type: 'native' } }, 429, { 'retry-after': '5' }));
    assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '5');
    const value = await response.json(); assert.equal(value.error.type, 'rate_limit_error'); assert(!JSON.stringify(value).includes('secret'));
  }
});

test('non-stream chat responses and provider usage are normalized without inventing missing counters', async () => {
  for (const [type, native, output, total] of [['ANTHROPIC', anthMessage, 4, 14], ['GEMINI', gemMessage, 6, 16]]) {
    const response = await executeProviderRequest(plan(type), async () => json(native));
    const value = await response.json();
    assert.equal(value.object, 'chat.completion'); assert.equal(value.choices[0].message.content, 'Hi!'); assert.equal(value.choices[0].finish_reason, 'stop');
    assert.equal(value.usage.prompt_tokens, 10); assert.equal(value.usage.completion_tokens, output); assert.equal(value.usage.total_tokens, total);
    assert.equal(response.infergate.usage.input_tokens, 10); assert.equal(response.infergate.usage.cached_input_tokens, 3);
  }
  assert.equal(anthropicUsage({ input_tokens: 0, output_tokens: 0 }).total_tokens, 0);
  assert.equal(anthropicUsage({ input_tokens: 0 }).completion_tokens, null);
  assert.equal(geminiUsage({ promptTokenCount: 0 }).completion_tokens_details.reasoning_tokens, null);
});

test('Gemini returned function calls round-trip their thought signatures', async () => {
  const native = { ...gemMessage, candidates: [{ content: { parts: [{ functionCall: { name: 'weather', args: { city: 'Berlin' } }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }] };
  const response = await executeProviderRequest(plan('GEMINI', { ...input, tools }), async () => json(native));
  const message = (await response.json()).choices[0].message;
  const followup = geminiRequest({ ...input, tools, messages: [input.messages[1], message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'Sunny' }] });
  assert.equal(followup.contents[1].parts[0].thoughtSignature, 'opaque-signature');
  assert.equal(followup.contents[2].parts[0].functionResponse.name, 'weather');
});

test('Anthropic SSE maps incremental text, tool deltas, finish and cumulative usage', async () => {
  const events = [
    { type: 'message_start', message: { ...anthMessage, content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hü' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_one', name: 'weather', input: {} } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"Berlin"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' }
  ];
  const response = await executeProviderRequest(plan('ANTHROPIC', { ...input, tools, stream: true, stream_options: { include_usage: true } }), async () => eventStream(events, true));
  const result = parseStream(await response.text());
  assert.equal(result.at(-1), '[DONE]');
  assert(result.some(e => e.choices?.[0]?.delta.content === 'Hü'));
  assert.equal(result.filter(e => e.choices?.[0]?.delta.tool_calls?.[0]?.function.arguments).map(e => e.choices[0].delta.tool_calls[0].function.arguments).join(''), '{"city":"Berlin"}');
  assert.equal(result.at(-3).choices[0].finish_reason, 'tool_calls');
  assert.equal(result.at(-2).usage.completion_tokens, 8); assert.equal(response.infergate.usage.output_tokens, 8);
});

test('Gemini SSE maps text and usage but omits provider thinking text', async () => {
  const response = await executeProviderRequest(plan('GEMINI', { ...input, stream: true, stream_options: { include_usage: true } }), async () => eventStream([
    { candidates: [{ content: { parts: [{ thought: true, text: 'hidden' }, { text: 'Hü' }] } }] },
    { ...gemMessage, candidates: [{ content: { parts: [{ text: '!' }] }, finishReason: 'STOP' }] }
  ], true));
  const text = await response.text(), result = parseStream(text);
  assert(!text.includes('hidden')); assert.equal(result.at(-1), '[DONE]'); assert.equal(result.at(-2).usage.completion_tokens_details.reasoning_tokens, 2);
  assert.equal(response.infergate.usage.total_tokens, 16);
});

test('native streaming yields the first chunk before the upstream completes', async () => {
  let source;
  const native = new Response(new ReadableStream({ start(controller) { source = controller; } }), { headers: { 'content-type': 'text/event-stream' } });
  const response = await executeProviderRequest(plan('GEMINI', { ...input, stream: true }), async () => native);
  source.enqueue(Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"first"}]}}]}\n\n'));
  const reader = response.body.getReader();
  const first = await reader.read(); assert(!first.done); assert(Buffer.from(first.value).toString().includes('assistant'));
  const delta = await reader.read(); assert(Buffer.from(delta.value).toString().includes('first'));
  source.enqueue(Buffer.from('data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1,"totalTokenCount":3}}\n\n')); source.close();
  let text = ''; for (;;) { const next = await reader.read(); if (next.done) break; text += Buffer.from(next.value); }
  assert(text.includes('[DONE]')); assert(!text.includes('"usage"')); assert.equal(response.infergate.usage.total_tokens, 3);
});

test('incomplete and errored native streams never emit a success terminator', async () => {
  for (const type of ['ANTHROPIC','GEMINI']) {
    const events = type === 'ANTHROPIC' ? [{ type: 'message_start', message: anthMessage }] : [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }];
    const response = await executeProviderRequest(plan(type, { ...input, stream: true }), async () => eventStream(events));
    await assert.rejects(response.text(), { code: 'incomplete_stream' });
    const errored = await executeProviderRequest(plan(type, { ...input, stream: true }), async () => eventStream([{ type: 'error', error: { message: 'secret' } }]));
    const text = await errored.text(); assert(text.includes('upstream_stream_error')); assert(!text.includes('[DONE]')); assert(!text.includes('secret'));
  }
});

test('multi-provider model selection is priority ordered and never substitutes another model', async () => {
  const assignments = [{ upstream_api_key_id: 1, key_status: 'ACTIVE', provider_status: 'ACTIVE' }, { upstream_api_key_id: 2, key_status: 'ACTIVE', provider_status: 'ACTIVE' }];
  const db = { query: async () => assignments }, seen = [];
  const lookup = async a => { seen.push(a.upstream_api_key_id); return { data: [{ id: a.upstream_api_key_id === 1 ? 'openai-model' : 'gemini-model' }] }; };
  assert.equal((await routeForModel(db, 1, 'gemini-model', lookup)).upstream_api_key_id, 2); assert.deepEqual(seen, [1,2]);
  const partial = a => a.upstream_api_key_id === 1 ? null : lookup(a);
  assert.equal((await routeForModel(db, 1, 'gemini-model', partial)).upstream_api_key_id, 2);
  await assert.rejects(routeForModel(db, 1, 'unavailable', partial), { code: 'model_discovery_unavailable' });
  await assert.rejects(routeForModel(db, 1, 'unavailable', lookup), { code: 'model_not_available' });
});


test('native error classification preserves HTTP status on unknown or malformed provider errors', async () => {
  const responses = [
    new Response('not-json', { status: 503 }),
    json({ error: { status: 'unexpected-secret', message: 'private-prompt' } }, 503),
    json({ error: { status: 'UNAVAILABLE', message: 'private-prompt' } }, 400),
    new Response('x'.repeat(70 * 1024), { status: 503 })
  ];
  for (const upstream of responses) {
    const response = await executeProviderRequest(plan('GEMINI'), async () => upstream);
    assert.equal(response.status, upstream.status);
    const value = await response.json(); assert.equal(value.error.code, `upstream_${upstream.status}`); assert(!JSON.stringify(value).includes('private-prompt'));
  }
  const unavailable = await executeProviderRequest(plan('GEMINI'), async () => json({ error: { status: 'UNAVAILABLE' } }, 503, { 'retry-after': '15' }));
  assert.equal(unavailable.headers.get('retry-after'), '15'); assert.equal((await unavailable.json()).error.message, 'Gemini is temporarily unavailable. Retry later.');
  const overloaded = await executeProviderRequest(plan('ANTHROPIC'), async () => json({ error: { type: 'overloaded_error' } }, 529));
  assert.equal(overloaded.status, 529); assert.equal((await overloaded.json()).error.code, 'upstream_overloaded');
});

test('Anthropic usage preserves reported thinking and totals, deriving totals from known components', async () => {
  for (const thinking of [0, 3, undefined, null, -1, '3', Number.MAX_SAFE_INTEGER + 1]) {
    const usage = { input_tokens: 5, output_tokens: 4, output_tokens_details: { thinking_tokens: thinking } };
    const expected = [0, 3].includes(thinking) ? thinking : null;
    assert.equal(anthropicUsage(usage).completion_tokens_details.reasoning_tokens, expected);
    assert.equal(anthropicUsage(usage).completion_tokens, 4);
    assert.equal(anthropicUsage(usage).total_tokens, 9);
    assert.equal(anthropicUsage({ ...usage, total_tokens: 9 }).total_tokens, 9);
    const response = await executeProviderRequest(plan('ANTHROPIC'), async () => json({ ...anthMessage, usage }));
    assert.equal((await response.json()).usage.completion_tokens_details.reasoning_tokens, expected);
    assert.equal(response.infergate.usage.reasoning_tokens, expected);
  }
  const response = await executeProviderRequest(plan('ANTHROPIC', { ...input, stream: true, stream_options: { include_usage: true } }), async () => eventStream([
    { type: 'message_start', message: { ...anthMessage, usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 3 } } },
    { type: 'message_stop' },
  ], true));
  const events = parseStream(await response.text());
  assert.equal(events.at(-2).usage.completion_tokens_details.reasoning_tokens, 3);
  assert.equal(response.infergate.usage.reasoning_tokens, 3);
  assert.equal(response.infergate.usage.output_tokens, 4);
  assert.equal(response.infergate.usage.total_tokens, 9);
});

test('Anthropic derived totals count cache and thinking once and preserve unknowns and explicit totals', () => {
  const usage = { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4, output_tokens_details: { thinking_tokens: 3 } };
  assert.equal(anthropicUsage(usage).total_tokens, 14);
  assert.equal(anthropicUsage({ ...usage, total_tokens: 99 }).total_tokens, 99);
  assert.equal(anthropicUsage({ ...usage, total_tokens: 0 }).total_tokens, 0);
  for (const patch of [{ input_tokens: undefined }, { output_tokens: null }, { output_tokens: -1 }, { cache_read_input_tokens: null }, { input_tokens: Number.MAX_SAFE_INTEGER }, { total_tokens: -1 }]) {
    assert.equal(anthropicUsage({ ...usage, ...patch }).total_tokens, null);
  }
});
