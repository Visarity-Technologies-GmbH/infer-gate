import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { messagesToChat, chatToMessages } from '../src/providers/messages-bridge.js';
import { prepareProviderRequest, executeProviderRequest } from '../src/providers/index.js';
import { encrypt } from '../src/security/credentials.js';
import { createApp } from '../src/app.js';

const config = { encryptionKey: randomBytes(32), modelDefault: 'DENY', bodyLimit: 20000, timeout: 5000 };
const input = { model: 'local-model', max_tokens: 100, system: 'Be brief', messages: [{ role: 'user', content: 'Hello' }] };
const tools = [{ name: 'lookup', description: 'Look up a value', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }];
const assignment = type => ({ api_type: type, api_url: 'https://mock.example/v1', aws_region: 'us-east-1', encrypted_api_key: encrypt('upstream-secret', config.encryptionKey), key_status: 'ACTIVE', provider_status: 'ACTIVE', upstream_api_key_id: 3, provider_id: 4 });
function plan(type, body = input, path = '/messages?beta=true') {
  return prepareProviderRequest(assignment(type), { url: path, method: 'POST', headers: { 'anthropic-beta': 'test-beta' }, get: name => ({ 'content-type': 'application/json', 'x-api-key': 'pak_client', authorization: 'Bearer pak_client', 'anthropic-beta': 'test-beta' })[name] }, Buffer.from(JSON.stringify(body)), config);
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const completion = (overrides = {}) => ({ id: 'chat_test', model: 'resolved-model', choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: { cached_tokens: 3, cache_creation_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } }, ...overrides });
function stream(events, bytewise = false) {
  const bytes = Buffer.from(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { if (bytewise) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); else controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const chunk = (delta, finish_reason = null, rest = {}) => ({ id: 'chat_stream', model: 'resolved-model', choices: [{ index: 0, delta, finish_reason }], ...rest });
const parseEvents = text => text.trim().split('\n\n').map(event => JSON.parse(event.split('\n').find(line => line.startsWith('data: ')).slice(6)));

test('Messages translates system, images, custom tools, choices and ordered results without mutating input', () => {
  const body = { ...input, temperature: 0.5, top_p: 0.8, stop_sequences: ['END'], tools, tool_choice: { type: 'tool', name: 'lookup', disable_parallel_tool_use: true }, thinking: { type: 'disabled' }, metadata: { user_id: 'client-user' }, cache_control: { type: 'ephemeral' }, messages: [
    { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 'call_one', name: 'lookup', input: { key: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_one', content: [{ type: 'text', text: 'Not found' }], is_error: true }, { type: 'text', text: 'Try again' }] },
  ] };
  const original = structuredClone(body), mapped = messagesToChat(body);
  assert.deepEqual(body, original); assert.equal(mapped.messages[0].role, 'system'); assert.equal(mapped.messages[1].content[0].image_url.url, 'data:image/png;base64,YQ==');
  assert.deepEqual(mapped.messages[2].tool_calls[0].function, { name: 'lookup', arguments: '{"key":"x"}' });
  assert.deepEqual(mapped.messages[3], { role: 'tool', tool_call_id: 'call_one', content: '[Tool error]\nNot found' }); assert.equal(mapped.messages[4].content[0].text, 'Try again');
  assert.deepEqual(mapped.tools[0].function.parameters, tools[0].input_schema); assert.equal(mapped.parallel_tool_calls, false); assert.deepEqual(mapped.stop, ['END']);
});

test('all non-Anthropic provider plans reuse chat adapters and replace credentials', () => {
  for (const type of ['OPENAI_COMPATIBLE','GEMINI','AWS_BEDROCK']) {
    const p = plan(type, { ...input, stream: true, tools });
    assert.equal(p.messagesBridge, true); assert.equal(p.init.redirect, 'manual'); assert.equal(p.init.headers.get('anthropic-beta'), null); assert.equal(p.init.headers.get('x-api-key'), null);
    if (type === 'GEMINI') {
      assert.equal(p.init.headers.get('x-goog-api-key'), 'upstream-secret'); assert.match(String(p.url), /:streamGenerateContent\?alt=sse$/); assert(JSON.parse(p.init.body).contents);
    } else {
      assert.equal(p.init.headers.get('authorization'), 'Bearer upstream-secret'); assert.match(String(p.url), /\/chat\/completions$/); assert.equal(JSON.parse(p.init.body).stream_options.include_usage, true);
      if (type === 'AWS_BEDROCK') assert.equal(p.url.hostname, 'bedrock-mantle.us-east-1.api.aws');
    }
  }
});

test('JSON chat text, tools and exact upstream usage become an Anthropic Message', async () => {
  const value = completion({ choices: [{ message: { content: 'Checking', tool_calls: [{ id: 'call_one', type: 'function', function: { name: 'lookup', arguments: '{"key":"x"}' } }] }, finish_reason: 'tool_calls' }] });
  for (const type of ['OPENAI_COMPATIBLE','AWS_BEDROCK']) {
    const response = await executeProviderRequest(plan(type, { ...input, tools }), async () => json(value));
    const body = await response.json(); assert.equal(body.type, 'message'); assert.equal(body.model, 'resolved-model'); assert.equal(body.stop_reason, 'tool_use');
    assert.deepEqual(body.content[1], { type: 'tool_use', id: 'call_one', name: 'lookup', input: { key: 'x' } });
    assert.deepEqual(body.usage, { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 });
    assert.equal(response.infergate.usage.input_tokens, 10); assert.equal(response.infergate.usage.total_tokens, 14); assert.equal(response.infergate.usage.reasoning_tokens, 1);
  }
  const missing = await chatToMessages(json(completion({ usage: undefined })), messagesToChat(input));
  assert.deepEqual((await missing.json()).usage, { input_tokens: null, output_tokens: null }); assert.equal(missing.infergate.usage, null);
});

test('chat SSE becomes native text/tool events and retains late usage through byte boundaries', async () => {
  const values = [chunk({ role: 'assistant' }), chunk({ content: 'Hü' }), chunk({ tool_calls: [{ index: 0, id: 'call_one', type: 'function', function: { name: 'look', arguments: '' } }] }), chunk({ tool_calls: [{ index: 0, function: { name: 'up', arguments: '{"key":' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }), chunk({}, 'tool_calls'), { model: 'resolved-model', choices: [], usage: completion().usage }, '[DONE]'];
  const response = await executeProviderRequest(plan('OPENAI_COMPATIBLE', { ...input, tools, stream: true }), async () => stream(values, true));
  const text = await response.text(), events = parseEvents(text);
  assert.equal(events[0].type, 'message_start'); assert.equal(events.at(-1).type, 'message_stop'); assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  assert(events.some(event => event.delta?.text === 'Hü')); assert(!text.includes('[DONE]'));
  const tool = events.find(event => event.content_block?.type === 'tool_use'); assert.equal(tool.content_block.name, 'lookup');
  const args = events.filter(event => event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join(''); assert.deepEqual(JSON.parse(args), { key: 'x' });
  assert.equal(response.infergate.usage.output_tokens, 4); assert.equal(response.infergate.usage.total_tokens, 14); assert.equal(events.at(-2).usage.input_tokens, 5);
});

test('Gemini signatures round-trip through native Messages tool_use extensions', async () => {
  const native = { modelVersion: 'gemini-model', candidates: [{ content: { parts: [{ functionCall: { id: 'native_call', name: 'lookup', args: { key: 'x' } }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, totalTokenCount: 16 } };
  for (const streamed of [false, true]) {
    const response = await executeProviderRequest(plan('GEMINI', { ...input, tools, stream: streamed }), async () => streamed ? stream([native]) : json(native));
    const tool = streamed ? parseEvents(await response.text()).find(event => event.content_block?.type === 'tool_use').content_block : (await response.json()).content[0];
    assert.equal(tool.extra_content.google.thought_signature, 'opaque-signature'); assert.equal(response.infergate.usage.reasoning_tokens, 2); assert.equal(response.infergate.usage.total_tokens, 16);
    const followup = plan('GEMINI', { ...input, tools, messages: [...input.messages, { role: 'assistant', content: [tool] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: 'done' }] }] });
    const parts = JSON.parse(followup.init.body).contents[1].parts;
    assert.equal(parts[0].thoughtSignature, 'opaque-signature'); assert.equal(parts[0].functionCall.id, 'native_call');
  }
});

test('unsupported features, query parameters and token counting fail before provider execution', () => {
  for (const type of ['OPENAI_COMPATIBLE','GEMINI','AWS_BEDROCK']) {
    for (const change of [{ thinking: { type: 'enabled', budget_tokens: 1000 } }, { top_k: 5 }, { output_config: { effort: 'high' } }, { tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, { messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden', signature: 'sig' }] }] }, { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'result' }] }] }]) assert.throws(() => plan(type, { ...input, ...change }), { status: 400 });
    assert.throws(() => plan(type, input, '/messages/count_tokens'), { status: 501, code: 'token_counting_unsupported' });
    assert.throws(() => plan(type, input, '/messages?unsupported=true'), { status: 400 });
  }
  assert.throws(() => plan('GEMINI', { ...input, tools, tool_choice: { type: 'auto', disable_parallel_tool_use: true } }), { status: 400 });
});

test('unsupported request diagnostics name fields without reflecting their values', () => {
  for (const field of ['output_config', 'context_management']) {
    assert.throws(() => messagesToChat({ ...input, [field]: { private_value: 'do-not-reflect' } }), error => {
      assert.equal(error.code, 'unsupported_messages_translation');
      assert.equal(error.message, `Unsupported Messages request field: ${field}`);
      assert(!error.message.includes('do-not-reflect')); return true;
    });
  }
  assert.throws(() => messagesToChat({ ...input, ['unsafe\nfield']: 'do-not-reflect' }), { message: 'Unsupported Messages request field' });
});

test('bridge errors and malformed/incomplete streams never expose diagnostics or emit success', async () => {
  for (const type of ['OPENAI_COMPATIBLE','GEMINI','AWS_BEDROCK']) {
    const response = await executeProviderRequest(plan(type), async () => json({ error: { message: 'private-prompt', status: 'UNAVAILABLE' } }, 503, { 'retry-after': '5' }));
    assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '5'); assert(!(await response.text()).includes('private-prompt'));
  }
  for (const events of [[chunk({ content: 'partial' })], [chunk({ content: 'partial' }), '[DONE]'], [chunk({ tool_calls: [{ index: 0, id: 'id', function: { name: 'lookup', arguments: 'invalid' } }] }), chunk({}, 'tool_calls'), '[DONE]']]) {
    const response = await chatToMessages(stream(events), { ...messagesToChat(input), stream: true });
    await assert.rejects(response.text());
  }
  const failed = await chatToMessages(stream([chunk({ content: 'partial' }, null, { usage: { prompt_tokens: 5 } }), { error: { message: 'private-prompt' } }]), { ...messagesToChat(input), stream: true });
  const text = await failed.text(); assert(!text.includes('private-prompt')); assert(!text.includes('message_stop')); assert.match(text, /event: error/); assert.equal(failed.infergate.usage.input_tokens, 5);
});

async function fixture(t, { type = 'OPENAI_COMPATIBLE', fetchImpl, cached, policies, timeout = 5000 } = {}) {
  const usage = [], records = [], costs = [], calls = [];
  const models = ['local-model', 'claude-requested'];
  const db = { async query(sql, params) {
    if (sql.includes('FROM user_usage_limits') || sql.startsWith('SELECT * FROM model_pricing')) return [];
    if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
    if (sql.includes('FROM proxy_api_keys k')) return [{ id: 1, user_id: 2, role_id: 7, role_status: 'ACTIVE', model_policy_id: 8, status: 'ACTIVE', user_status: 'ACTIVE', classification_handler_id: cached ? 9 : null }];
    if (sql.includes('FROM role_model_policies')) return policies || [{ model_pattern: '*', policy: 'ALLOW' }];
    if (sql.includes('FROM role_upstream_assignments')) return [assignment(type)];
    if (sql.startsWith('INSERT INTO usage_events')) { usage.push(params); return { insertId: 1 }; }
    if (sql.startsWith('INSERT INTO usage_costs')) costs.push(params);
    if (sql.startsWith('UPDATE api_requests SET user_id=')) records.push(params);
    return { affectedRows: 1 };
  }, async transaction(fn) { return fn(db); } };
  const app = createApp(db, { ...config, timeout }, { log() {}, classificationCache: cached ? { async get() { return { version: 1, model: 'local-model', category: 'other', sensitiveData: false, complexity: 0 }; } } : undefined, fetchImpl: async (url, init) => {
    // Model discovery runs before routing; answer it here and keep `calls` limited to inference requests.
    if (new URL(url).pathname.endsWith('/models')) return json(type === 'GEMINI' ? { models: models.map(id => ({ name: `models/${id}` })) } : { data: models.map(id => ({ id })) });
    calls.push({ url, init }); return fetchImpl ? fetchImpl(url, init) : json(completion());
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (body = input, path = '/v1/messages?beta=true') => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'pak_client' }, body: JSON.stringify(body) });
  return { request, usage, records, costs, calls };
}

test('HTTP translation applies cached remapping/current policy and accounts actual totals and reasoning', async t => {
  for (const denied of [false, true]) {
    const f = await fixture(t, { cached: true, policies: [{ model_pattern: '*', policy: 'ALLOW' }, ...(denied ? [{ model_pattern: 'local-model', policy: 'DENY' }] : [])] });
    const response = await f.request({ ...input, model: 'claude-requested', tools }); await response.text(); assert.equal(response.status, denied ? 403 : 200);
    assert.equal(f.calls.length, denied ? 0 : 1);
    if (!denied) {
      assert.equal(JSON.parse(f.calls[0].init.body).model, 'local-model'); assert.equal(f.usage[0][16], 'claude-requested'); assert.equal(f.usage[0][6], 10); assert.equal(f.usage[0][10], 1); assert.equal(f.usage[0][11], 14); assert.equal(f.records[0][10], 'SUCCESS');
    }
  }
});

test('HTTP responses without upstream usage never create usage or cost records', async t => {
  for (const streamed of [false, true]) {
    const f = await fixture(t, { fetchImpl: () => streamed ? stream([chunk({ content: 'Hi' }), chunk({}, 'stop'), '[DONE]']) : json(completion({ usage: undefined })) });
    const response = await f.request({ ...input, stream: streamed }); await response.text(); assert.equal(response.status, 200); assert.equal(f.usage.length, 0); assert.equal(f.costs.length, 0); assert.equal(f.records[0][10], 'SUCCESS');
  }
});

test('HTTP translated streams deliver early data, cancel upstream and retain actual partial usage', async t => {
  for (const reason of ['disconnect','timeout']) {
    let aborted = false;
    const f = await fixture(t, { timeout: reason === 'timeout' ? 100 : 5000, fetchImpl: (url, init) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(`data: ${JSON.stringify(chunk({ content: 'first' }, null, { usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }))}\n\n`));
      init.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')); }, { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await f.request({ ...input, stream: true });
    if (reason === 'disconnect') { const reader = response.body.getReader(); assert(!(await reader.read()).done); await reader.cancel(); } else await assert.rejects(response.text());
    for (let i = 0; i < 100 && !f.records.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(aborted); assert.equal(f.records[0][10], reason === 'disconnect' ? 'CANCELLED' : 'FAILED'); assert.equal(f.usage[0][6], 5); assert.equal(f.usage[0][11], 6);
  }
});

test('parallel streamed tool calls retain their indexes and complete separately', async () => {
  const response = await chatToMessages(stream([
    chunk({ tool_calls: [{ index: 0, id: 'first', function: { name: 'lookup', arguments: '{"key":' } }, { index: 1, id: 'second', function: { name: 'lookup', arguments: '{"key":' } }] }),
    chunk({ tool_calls: [{ index: 1, function: { arguments: '"b"}' } }, { index: 0, function: { arguments: '"a"}' } }] }), chunk({}, 'tool_calls'), '[DONE]',
  ]), { ...messagesToChat(input), stream: true });
  const events = parseEvents(await response.text()), starts = events.filter(event => event.content_block?.type === 'tool_use');
  assert.equal(starts.length, 2); assert.notEqual(starts[0].index, starts[1].index);
  for (const [i, expected] of ['a','b'].entries()) {
    const args = events.filter(event => event.index === starts[i].index && event.delta?.type === 'input_json_delta').map(event => event.delta.partial_json).join('');
    assert.deepEqual(JSON.parse(args), { key: expected });
    assert.equal(events.filter(event => event.index === starts[i].index && event.type === 'content_block_stop').length, 1);
  }
});

test('finish reasons and unavailable counters translate without fabricating totals or reasoning text', async () => {
  for (const [reason, expected] of [['stop','end_turn'], ['length','max_tokens'], ['content_filter','refusal']]) {
    const response = await chatToMessages(json(completion({ choices: [{ message: { content: 'text', reasoning_content: 'private reasoning' }, finish_reason: reason }], usage: { prompt_tokens: 0, completion_tokens: 0 } })), messagesToChat(input));
    const message = await response.json(); assert.equal(message.stop_reason, expected); assert.equal(message.usage.input_tokens, 0); assert.equal(message.usage.output_tokens, 0);
    assert.equal(response.infergate.usage.total_tokens, null); assert.equal(response.infergate.usage.reasoning_tokens, null); assert(!JSON.stringify(message).includes('private reasoning'));
  }
  const response = await chatToMessages(stream([chunk({ role: 'assistant' }, null, { service_tier: 'priority' }), chunk({ content: 'Hi' }), chunk({}, 'stop'), { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }, '[DONE]']), { ...messagesToChat(input), stream: true });
  await response.text(); assert.equal(response.infergate.usage.billing_unsupported, true);
});

test('translated token counting returns a native error without an upstream call or consumption', async t => {
  for (const type of ['OPENAI_COMPATIBLE','GEMINI','AWS_BEDROCK']) {
    const f = await fixture(t, { type }), response = await f.request(input, '/v1/messages/count_tokens');
    assert.equal(response.status, 501); assert.equal((await response.json()).type, 'error'); assert.equal(f.calls.length, 0); assert.equal(f.usage.length, 0);
  }
});

test('streamed tool metadata has cumulative byte and tool-count bounds', async () => {
  const unicode = '€'.repeat(200000);
  const oversized = [chunk({ tool_calls: [{ index: 0, id: 'call', function: { name: 'lookup', arguments: '{"value":"' + unicode } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: unicode + '"}' } }] }), chunk({}, 'tool_calls'), '[DONE]'];
  const many = [chunk({ tool_calls: Array.from({ length: 101 }, (_, index) => ({ index, id: `call_${index}`, function: { name: 'lookup', arguments: '{}' } })) }), chunk({}, 'tool_calls'), '[DONE]'];
  for (const events of [oversized, many]) {
    const response = await chatToMessages(stream(events), { ...messagesToChat(input), stream: true });
    await assert.rejects(response.text(), { status: 502 });
  }
});

test('backend system-role rejections retain Claude Code recovery cues without exposing diagnostics', async () => {
  for (const type of ['OPENAI_COMPATIBLE','GEMINI','AWS_BEDROCK']) {
    const response = await executeProviderRequest(plan(type), async () => json({ error: { message: 'System message must be at the beginning. Private prompt text.', type: 'BadRequestError' } }, 400));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.type, 'error');
    assert.equal(body.error.message, 'capability_rejected: mid_conv_system');
    assert(!JSON.stringify(body).includes('Private prompt text'));
    assert.equal(response.infergate.error.code, 'upstream_400');
  }
});
