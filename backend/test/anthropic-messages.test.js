import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { encrypt } from '../src/security/credentials.js';
import { UsageCollector } from '../src/services/usage.js';
import { classificationCacheKey } from '../src/services/classification-cache.js';
import { supportsTokenBilling, calculateCost } from '../src/services/accounting.js';

const input = { model: 'claude-test', max_tokens: 100, system: [{ type: 'text', text: 'Be brief', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'Hello' }], tools: [{ name: 'lookup', input_schema: { type: 'object' } }], thinking: { type: 'enabled', budget_tokens: 50 } };
const message = { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-test', content: [{ type: 'thinking', thinking: 'Thinking', signature: 'opaque' }, { type: 'tool_use', id: 'tool_test', name: 'lookup', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 } };
const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } }, { type: 'ping' }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Hü' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }, { type: 'message_stop' }];
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
const stream = values => new Response(values.map(value => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
async function fixture(t, options = {}) {
  const encryptionKey = randomBytes(32), calls = [], queries = [], usage = [], records = [];
  const key = { id: 1, user_id: 2, role_id: 7, role_status: 'ACTIVE', model_policy_id: 8, status: 'ACTIVE', user_status: 'ACTIVE', ...options.key };
  const assignment = { upstream_api_key_id: 3, provider_id: 4, key_status: 'ACTIVE', provider_status: 'ACTIVE', api_type: options.type || 'ANTHROPIC', aws_region: options.region, anthropic_api_url: options.anthropicUrl, api_url: 'https://mock.example/v1', encrypted_api_key: encrypt('upstream-test-secret', encryptionKey) };
  const db = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.includes('FROM user_usage_limits')) return options.cap ? [{ enabled: 1, period: 'DAILY', basis: 'TOKENS', token_limit: '1' }] : [];
    if (sql.includes('SUM(') && options.cap) return [{ consumed: '1' }];
    if (sql.startsWith('SELECT * FROM model_pricing')) return options.pricing ? [options.pricing] : [];
    if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
    if (sql.includes('FROM proxy_api_keys k')) return [key];
    if (sql.includes('FROM model_policy_rules')) return options.policies || [{ model_pattern: 'claude-*', policy: 'ALLOW' }];
    if (sql.includes('FROM role_upstream_assignments')) return [assignment];
    if (sql.includes('FROM classification_handlers')) return [{ api_url: 'https://classifier.example', encrypted_api_key: encrypt('classifier-secret', encryptionKey), json_template: '{"prompt":"${PROMPT}"}' }];
    if (sql.startsWith('INSERT INTO usage_events')) { usage.push(Object.fromEntries(sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((name, i) => [name, params[i]]))); return { insertId: 1 }; }
    if (sql.startsWith('UPDATE api_requests SET user_id=')) records.push(params);
    return { affectedRows: 1 };
  }, async transaction(fn) { return fn(db); } };
  const app = createApp(db, { encryptionKey, modelDefault: 'DENY', bodyLimit: options.bodyLimit || 10000, timeout: options.timeout || 5000 }, { log() {}, classificationCache: options.cache, fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return options.fetch ? options.fetch(url, init) : json(message); } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (body = input, path = '/v1/messages?beta=true', headers = {}, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'x-api-key': 'pak_client_test', 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'future-beta', ...headers }, body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { request, calls, usage, queries, records, key };
}

test('Messages preserves native requests/responses and replaces client credentials', async t => {
  const f = await fixture(t, { fetch: () => json(message, 200, { 'request-id': 'req_native', 'anthropic-ratelimit-requests-remaining': '5', 'x-should-retry': 'false' }) });
  const body = JSON.stringify({ ...input, future_option: { enabled: true } }, null, 2);
  const response = await f.request(body, undefined, { authorization: 'Bearer pak_client_test', cookie: 'private', 'x-claude-code-session-id': 'session' });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), message);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'https://mock.example/v1/messages?beta=true');
  assert.equal(f.calls[0].init.body.toString(), body);
  const headers = f.calls[0].init.headers;
  assert.equal(headers.get('x-api-key'), 'upstream-test-secret'); assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null);
  assert.equal(headers.get('anthropic-version'), '2023-06-01'); assert.equal(headers.get('anthropic-beta'), 'future-beta'); assert.equal(f.calls[0].init.redirect, 'manual');
  assert.equal(response.headers.get('request-id'), 'req_native'); assert.equal(response.headers.get('anthropic-ratelimit-requests-remaining'), '5'); assert.equal(response.headers.get('x-should-retry'), 'false');
  assert.equal(f.records[0][11], 'req_native');
  assert.equal(f.usage[0].input_tokens, 10); assert.equal(f.usage[0].cached_input_tokens, 3); assert.equal(f.usage[0].cache_write_input_tokens, 2); assert.equal(f.usage[0].output_tokens, 4); assert.equal(f.usage[0].total_tokens, 14);
});

test('Messages and Chat accounting retain the sent model when upstream reports a different model', async t => {
  for (const native of [true, false]) for (const streaming of [false, true]) {
    const reportedModel = 'upstream-version';
    const payload = native ? { ...message, model: reportedModel } : { model: reportedModel, choices: [], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } };
    const f = await fixture(t, {
      type: native ? 'ANTHROPIC' : 'OPENAI_COMPATIBLE',
      fetch: () => !streaming ? json(payload) : native
        ? stream(events.map(event => event.type === 'message_start' ? { ...event, message: { ...event.message, model: reportedModel } } : event))
        : new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    });
    const response = await f.request({ model: input.model, max_tokens: 100, messages: input.messages, stream: streaming }, native ? '/v1/messages' : '/v1/chat/completions', { authorization: 'Bearer pak_client_test' });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /upstream-version/);
    assert.equal(f.usage[0].model, input.model);
    assert.equal(f.usage[0].requestedModel, input.model);
    assert.equal(f.records[0][5], input.model);
  }
});

test('Messages streams native events and cumulative usage with bounded UTF-8 inspection', async t => {
  const f = await fixture(t, { fetch: () => stream(events) });
  const response = await f.request({ ...input, stream: true });
  const text = await response.text();
  assert.match(text, /event: ping/); assert.match(text, /thinking_delta/); assert.match(text, /Hü/); assert.match(text, /event: message_stop/); assert(!text.includes('[DONE]'));
  assert.equal(f.records[0][10], 'SUCCESS'); assert.equal(f.usage[0].input_tokens, 10); assert.equal(f.usage[0].output_tokens, 8);
  const collector = new UsageCollector('text/event-stream', undefined, 'ANTHROPIC');
  for (const byte of Buffer.from(text)) collector.push(Uint8Array.of(byte)); collector.finish();
  assert.equal(collector.usage.input_tokens, 10); assert.equal(collector.usage.output_tokens, 8); assert.equal(collector.terminal, true);
  const unknown = new UsageCollector('application/json', undefined, 'ANTHROPIC'); unknown.push(Buffer.from(JSON.stringify({ ...message, usage: { input_tokens: 0, output_tokens: 0 } }))); unknown.finish();
  assert.equal(unknown.usage.input_tokens, 0); assert.equal(unknown.usage.cached_input_tokens, null); assert.equal(unknown.usage.total_tokens, 0);
});

test('incomplete and failed Messages streams retain partial usage and fail tracking', async t => {
  for (const values of [events.slice(0, 3), [...events.slice(0, 3), { type: 'error', error: { type: 'overloaded_error', message: 'private provider diagnostics' } }]]) {
    const f = await fixture(t, { fetch: () => stream(values) });
    const response = await f.request({ ...input, stream: true });
    assert(!(await response.text()).includes('private provider diagnostics'));
    assert.equal(f.records[0][10], 'FAILED'); assert.equal(f.usage[0].input_tokens, 10);
  }
});

test('token counting enforces policy without classification, remapping or consumption', async t => {
  const f = await fixture(t, { key: { classification_handler_id: 9 }, fetch: () => json({ input_tokens: 50 }) });
  const { max_tokens, ...countInput } = input;
  const response = await f.request(countInput, '/v1/messages/count_tokens/?beta=true');
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { input_tokens: 50 }); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://mock.example/v1/messages/count_tokens/?beta=true'); assert.equal(f.usage.length, 0);
  assert(!f.queries.some(({ sql }) => sql === 'UPDATE api_requests SET usage_expected=TRUE WHERE id=?'));
});

test('Messages validates bodies, authorization, roles, policy and provider before forwarding', async t => {
  const cases = [
    [{}, { ...input, model: undefined }, 400], [{}, { ...input, messages: undefined }, 400], [{}, { ...input, max_tokens: 0 }, 400], [{}, '{', 400], [{}, '', 400],
    [{ key: { status: 'REVOKED' } }, input, 401], [{ key: { user_status: 'SUSPENDED' } }, input, 403], [{ key: { role_id: null } }, input, 403], [{ key: { role_status: 'DISABLED' } }, input, 403],
    [{ policies: [{ model_pattern: '*', policy: 'DENY' }] }, input, 403], [{ type: 'GEMINI' }, input, 400], [{ type: 'OPENAI_COMPATIBLE' }, input, 400], [{ type: 'AWS_BEDROCK' }, input, 400], [{ bodyLimit: 10 }, input, 413], [{ cap: true }, input, 429],
  ];
  for (const [options, body, status] of cases) {
    const f = await fixture(t, options), response = await f.request(body);
    assert.equal(response.status, status, JSON.stringify(options)); assert.equal((await response.json()).type, 'error'); assert.equal(f.calls.length, 0); assert.equal(f.usage.length, 0);
  }
  const f = await fixture(t);
  for (const headers of [{ authorization: 'Bearer invalid' }, { 'x-api-key': 'invalid' }]) { const response = await f.request(input, undefined, headers); assert.equal(response.status, 401); }
  assert.equal((await f.request(input, undefined, { 'content-type': 'text/plain' })).status, 400);
  assert.equal((await f.request(input, '/v1/messages', {}, 'GET')).status, 405);
});

test('Messages provider errors use native safe envelopes and retry headers', async t => {
  const f = await fixture(t, { fetch: () => json({ type: 'error', error: { type: 'overloaded_error', message: 'private diagnostic' } }, 529, { 'retry-after': '5' }) });
  const response = await f.request(); assert.equal(response.status, 529); assert.equal(response.headers.get('retry-after'), '5');
  const value = await response.json(); assert.equal(value.type, 'error'); assert.equal(value.error.type, 'overloaded_error'); assert(!JSON.stringify(value).includes('private diagnostic'));
});

test('classification uses native top-level system and evaluation sees the original request', async t => {
  let classified, evaluated;
  const cacheWrites = [], cache = { async get() { return null; }, async set(key, value) { cacheWrites.push({ key, value }); } };
  const script = 'async function evaluate(input, input_type, classification, models, context) { if (input_type !== "ANTHROPIC") throw new Error("wrong protocol"); return { category: input.system[0].text, sensitiveData: false, complexity: 0, models: ["claude-cheaper"] }; }';
  const f = await fixture(t, { key: { classification_handler_id: 9, evaluation_script: script }, cache, fetch: (url, init) => {
    if (String(url).startsWith('https://classifier')) { classified = JSON.parse(JSON.parse(init.body).prompt); return json({ category: 'other' }); }
    if (String(url).endsWith('/models')) return json({ data: [{ id: 'claude-cheaper' }], has_more: false });
    evaluated = JSON.parse(init.body); return json({ ...message, model: 'claude-cheaper' });
  } });
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(classified, [{ role: 'system', content: input.system }, ...input.messages]);
  assert.deepEqual(evaluated, { ...input, model: 'claude-cheaper' }); assert.equal(f.usage[0].requestedModel, 'claude-test'); assert.equal(f.usage[0].model, 'claude-cheaper'); assert.equal(f.usage[0].category, 'Be brief');
  assert.equal(cacheWrites.length, 1);
  assert.notEqual(classificationCacheKey(f.key, classified), classificationCacheKey(f.key, classified, 'ANTHROPIC'));
  assert.notEqual(classificationCacheKey(f.key, classified, 'ANTHROPIC'), classificationCacheKey(f.key, [{ role: 'system', content: 'different' }, ...input.messages], 'ANTHROPIC'));
});

test('native Messages supports text/tool estimates but flags unsupported billing', async () => {
  assert.equal(supportsTokenBilling(input, { anthropic: true }), true);
  for (const tools of [[{ type: 'web_search_20250305', name: 'web_search' }]]) assert.equal(supportsTokenBilling({ ...input, tools }, { anthropic: true }), false);
  const cost = await calculateCost({ query: async () => [{ id: 1, currency: 'USD', source_kind: 'MANUAL', input_price_per_million: '1', output_price_per_million: '2', cached_input_price_per_million: '0.1', cache_write_price_per_million: '1.25' }] }, { api_type: 'ANTHROPIC', endpoint: '/v1/messages', provider_id: 4, requestedProvider_id: 4, model_requested: 'claude-test', started_at: new Date() }, { input_tokens: 10, cached_input_tokens: 3, cache_write_input_tokens: 2, output_tokens: 4 }, 'claude-test');
  assert.equal(cost.status, 'COMPLETE'); assert.equal(cost.known_cost, '0.000015800000');
});

test('cached native classifications still enforce current policies and preserve native fields', async t => {
  const cached = { version: 1, model: 'claude-cheaper', category: 'cached', sensitiveData: false, complexity: 1 };
  for (const denied of [false, true]) {
    const f = await fixture(t, { key: { classification_handler_id: 9 }, cache: { async get() { return cached; } }, policies: [{ model_pattern: 'claude-*', policy: 'ALLOW' }, ...(denied ? [{ model_pattern: 'claude-cheaper', policy: 'DENY' }] : [])] });
    const response = await f.request(); await response.text();
    assert.equal(response.status, denied ? 403 : 200); assert.equal(f.calls.length, denied ? 0 : 1);
    if (!denied) assert.deepEqual(JSON.parse(f.calls[0].init.body), { ...input, model: 'claude-cheaper' });
  }
});

test('Messages forwards the first event before upstream finishes and does not invent missing usage', async t => {
  let source;
  const f = await fixture(t, { fetch: () => new Response(new ReadableStream({ start(controller) { source = controller; controller.enqueue(Buffer.from(`event: ping\ndata: {"type":"ping"}\n\n`)); } }), { headers: { 'content-type': 'text/event-stream' } }) });
  const response = await f.request({ ...input, stream: true }), reader = response.body.getReader();
  const first = await reader.read(); assert.match(Buffer.from(first.value).toString(), /event: ping/);
  source.enqueue(Buffer.from(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''))); source.close();
  while (!(await reader.read()).done) { /* Drain without buffering the response. */ }
  assert.equal(f.usage[0].input_tokens, 10);
  const missing = await fixture(t, { fetch: () => json({ ...message, usage: undefined }) });
  await (await missing.request()).text(); assert.equal(missing.usage.length, 0);
});

test('native billing inspection supports long-lived caching, detects server tools and bounds oversized events', () => {
  for (const usage of [{ input_tokens: 1, server_tool_use: { web_search_requests: 1 } }]) {
    const collector = new UsageCollector('application/json', undefined, 'ANTHROPIC'); collector.push(Buffer.from(JSON.stringify({ ...message, usage }))); collector.finish(); assert.equal(collector.usage.billing_unsupported, true);
  }
  const collector = new UsageCollector('text/event-stream', 100, 'ANTHROPIC');
  collector.push(Buffer.from(`data: ${JSON.stringify({ type: 'message_start', message: { ...message, content: [{ type: 'text', text: 'x'.repeat(1000) }] } })}\n\n`)); collector.finish(); assert.equal(collector.usage, null);
});

test('native errors retain fixed Claude Code recovery cues without reflecting diagnostics', async t => {
  for (const [diagnostic, cue] of [['prompt is too long: private payload details', 'prompt is too long'], ['thinking.type.enabled is not supported private details', 'thinking.type.enabled is not supported'], ['thinking block bound to a different conversation: private', 'thinking block is bound to a different conversation'], ['unknown private diagnostic', 'Upstream provider request failed (HTTP 400)']]) {
    const f = await fixture(t, { fetch: () => new Response(JSON.stringify({ error: { message: diagnostic } }), { status: 400, headers: { 'content-type': 'text/plain' } }) });
    const response = await f.request(); assert.match(response.headers.get('content-type'), /application\/json/); assert.equal((await response.json()).error.message, cue);
  }
});

test('Claude Code model discovery accepts an x-api-key and still applies model policy', async t => {
  const f = await fixture(t, { fetch: () => json({ data: [{ id: 'claude-test' }, { id: 'denied-model' }], has_more: false }) });
  const response = await f.request(input, '/v1/models?limit=1000', {}, 'GET'); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(model => model.id), ['claude-test']); assert.equal(f.usage.length, 0);
});

test('native Messages stores reported thinking breakdowns from JSON and final stream usage', async t => {
  for (const thinking of [0, 3, undefined]) for (const streamed of [false, true]) {
    const details = thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } };
    const f = await fixture(t, { fetch: () => streamed
      ? stream(events.map(event => event.type === 'message_delta' ? { ...event, usage: { ...event.usage, ...details } } : event))
      : json({ ...message, usage: { ...message.usage, ...details } }) });
    const response = await f.request({ ...input, stream: streamed }); assert.equal(response.status, 200); await response.text();
    assert.equal(f.usage[0].reasoning_tokens, thinking ?? null);
    assert.equal(f.usage[0].output_tokens, streamed ? 8 : 4);
    assert.equal(f.usage[0].total_tokens, streamed ? 18 : 14);
  }
});

test('Bedrock Claude native HTTP forwarding preserves effort and records usage and costs', async t => {
  const model = 'anthropic.claude-opus-4-7';
  for (const streamed of [false, true]) {
    const f = await fixture(t, { type: 'AWS_BEDROCK', region: 'us-east-1', policies: [{ model_pattern: 'anthropic.*', policy: 'ALLOW' }],
      pricing: { id: 1, currency: 'USD', input_price_per_million: '2', cached_input_price_per_million: '0.2', cache_write_price_per_million: '2.5', output_price_per_million: '10' }, fetch: () => streamed
      ? stream(events.map(event => event.type === 'message_start' ? { ...event, message: { ...event.message, model } } : event))
      : json({ ...message, model }) });
    const body = { ...input, model, stream: streamed, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } };
    const response = await f.request(body); assert.equal(response.status, 200); await response.text();
    assert.equal(f.calls[0].url, 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages?beta=true');
    assert.deepEqual(JSON.parse(f.calls[0].init.body), body); assert.equal(f.calls[0].init.headers.get('x-api-key'), 'upstream-test-secret'); assert.equal(f.calls[0].init.headers.get('authorization'), null);
    assert.equal(f.usage[0].model, model); assert.equal(f.usage[0].input_tokens, 10); assert.equal(f.usage[0].output_tokens, streamed ? 8 : 4); assert.equal(f.usage[0].total_tokens, streamed ? 18 : 14);
    const insert = f.queries.find(({ sql }) => sql.startsWith('INSERT INTO usage_costs'));
    const names = insert.sql.slice(insert.sql.indexOf('(') + 1, insert.sql.indexOf(')')).split(',');
    const cost = Object.fromEntries(names.slice(0, -1).map((name, i) => [name, insert.params[i]]));
    assert.equal(cost.status, 'COMPLETE'); assert.equal(cost.pricing_id, 1);
    assert.equal(cost.input_cost, '0.000010000000'); assert.equal(cost.cached_input_cost, '0.000000600000');
    assert.equal(cost.cache_write_cost, '0.000005000000'); assert.equal(cost.output_cost, streamed ? '0.000080000000' : '0.000040000000');
    assert.equal(cost.known_cost, streamed ? '0.000095600000' : '0.000055600000');
  }
  const count = await fixture(t, { type: 'AWS_BEDROCK', region: 'us-east-1', policies: [{ model_pattern: 'anthropic.*', policy: 'ALLOW' }], fetch: () => json({ input_tokens: 10 }) });
  const response = await count.request({ model, messages: input.messages }, '/v1/messages/count_tokens'); assert.equal(response.status, 200); await response.text();
  assert.equal(count.usage.length, 0); assert(!count.queries.some(({ sql }) => sql === 'UPDATE api_requests SET usage_expected=TRUE WHERE id=?'));
});


test('dual providers relay native Messages JSON/SSE and count tokens using the configured base', async t => {
  for (const anthropicUrl of [null, 'https://native.example/anthropic/v1']) {
    for (const streaming of [false, true]) {
      const f = await fixture(t, { type: 'OPENAI_ANTHROPIC', anthropicUrl,
        fetch: () => streaming ? stream(events) : json(message) });
      const response = await f.request({ ...input, stream: streaming });
      assert.equal(response.status, 200);
      const output = await response.text();
      assert.match(output, streaming ? /message_stop/ : /signature/);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].url, `${anthropicUrl || 'https://mock.example/v1'}/messages?beta=true`);
      assert.deepEqual(JSON.parse(f.calls[0].init.body), { ...input, stream: streaming });
      assert.equal(f.calls[0].init.headers.get('x-api-key'), 'upstream-test-secret');
      assert.equal(f.calls[0].init.headers.get('authorization'), null);
      assert.equal(f.calls[0].init.redirect, 'manual');
      assert.equal(f.records[0][10], 'SUCCESS');
      assert.equal(f.usage[0].input_tokens, 10);
      assert.equal(f.usage[0].cache_write_input_tokens, 2);
    }
    const f = await fixture(t, { type: 'OPENAI_ANTHROPIC', anthropicUrl, fetch: () => json({ input_tokens: 10 }) });
    const response = await f.request({ model: input.model, messages: input.messages }, '/v1/messages/count_tokens');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { input_tokens: 10 });
    assert.equal(f.calls[0].url, `${anthropicUrl || 'https://mock.example/v1'}/messages/count_tokens`);
    assert.equal(f.usage.length, 0);
    assert(!f.queries.some(q => q.sql.includes('usage_expected=TRUE')));
  }
});

test('dual provider native failures are sanitized without retrying the OpenAI endpoint', async t => {
  const f = await fixture(t, { type: 'OPENAI_ANTHROPIC', fetch: () => json({ error: { type: 'api_error', message: 'secret prompt' } }, 500) });
  const response = await f.request();
  assert.equal(response.status, 500);
  assert(!(await response.text()).includes('secret prompt'));
  assert.equal(f.calls.length, 1);
});

test('dual providers keep Chat JSON/SSE on the OpenAI protocol with authoritative usage', async t => {
  for (const streaming of [false, true]) {
    const payload = { model: 'reported-alias', choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } };
    const f = await fixture(t, { type: 'OPENAI_ANTHROPIC', anthropicUrl: 'https://native.example/v1',
      fetch: () => streaming ? new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } }) : json(payload) });
    const response = await f.request({ model: input.model, messages: input.messages, stream: streaming }, '/v1/chat/completions', { authorization: 'Bearer pak_client_test' });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /reported-alias/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://mock.example/v1/chat/completions');
    assert.equal(f.calls[0].init.headers.get('authorization'), 'Bearer upstream-test-secret');
    assert.equal(f.calls[0].init.headers.get('x-api-key'), null);
    if (streaming) assert.equal(JSON.parse(f.calls[0].init.body).stream_options.include_usage, true);
    assert.equal(f.usage[0].model, input.model);
    assert.equal(f.usage[0].total_tokens, 9);
    assert.equal(f.records[0][10], 'SUCCESS');
  }
});

test('native custom prompt receives full Anthropic input and passes context to evaluation', async t => {
  let classified, forwarded;
  const f = await fixture(t, {
    key: {
      classification_handler_id: 9,
      classification_max_token: 100,
      prompt_script: `async function prompt(input, type, limit, context) {
        context.category = type;
        return JSON.stringify({ system: input.system, type, limit, model: input.model });
      }`,
      evaluation_script: `async function evaluate(input, input_type, classification, models, context) {
        return { category: context.category, sensitiveData: false, models: null };
      }`,
    },
    fetch: (url, init) => {
      if (String(url).startsWith('https://classifier')) { classified = JSON.parse(JSON.parse(init.body).prompt); return json({}); }
      if (String(url).endsWith('/models')) return json({ data: [{ id: 'claude-test' }], has_more: false });
      forwarded = JSON.parse(init.body); return json(message);
    },
  });
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(classified, { system: input.system, type: 'ANTHROPIC', limit: 90, model: input.model });
  assert.deepEqual(forwarded, input);
  assert.equal(f.usage[0].category, 'ANTHROPIC');
});

test('token counting skips custom prompt scripts', async t => {
  const f = await fixture(t, { key: { classification_handler_id: 9, prompt_script: 'async function prompt() { throw new Error("must not run"); }' }, fetch: () => json({ input_tokens: 50 }) });
  const { max_tokens, ...countInput } = input;
  const response = await f.request(countInput, '/v1/messages/count_tokens');
  assert.equal(response.status, 200);
});

test('native input scripts replace the request and preserve original model attribution', async t => {
  const f = await fixture(t, { key: { input_script: `async function updateInput(input, type, context) {
    await Promise.resolve();
    if (type !== 'ANTHROPIC') throw new Error('wrong type');
    input.system = 'Modified system';
    input.model = 'claude-updated';
    return input;
  }` } });
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { ...input, system: 'Modified system', model: 'claude-updated' });
  assert.equal(f.usage[0].model, 'claude-updated');
  assert.equal(f.usage[0].requestedModel, input.model);
});

test('input scripts skip count_tokens and invalid transformed native requests never reach upstream', async t => {
  const count = await fixture(t, { key: { input_script: 'async function updateInput() { throw new Error("must not run"); }' }, fetch: () => json({ input_tokens: 50 }) });
  const { max_tokens, ...countInput } = input;
  assert.equal((await count.request(countInput, '/v1/messages/count_tokens')).status, 200);
  const invalid = await fixture(t, { key: { input_script: 'async function updateInput(input) { input.max_tokens = -1; return input; }' } });
  const response = await invalid.request();
  assert.equal(response.status, 400);
  assert.equal(invalid.calls.length, 0);
});


test('output scripts receive native and translated Anthropic JSON before it is sent', async t => {
  for (const translated of [false, true]) {
    const f = await fixture(t, {
      type: translated ? 'OPENAI_COMPATIBLE' : 'ANTHROPIC',
      key: { output_script: `async function updateOutput(output, type, context) {
        if (type !== 'ANTHROPIC' || output.type !== 'message') throw new Error('wrong protocol');
        output.content = [{ type: 'text', text: 'Updated native output' }];
        output.usage.output_tokens = 999;
        return output;
      }` },
      fetch: () => translated ? json({ id: 'chat-test', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'original' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } }) : json(message),
    });
    const { thinking, ...body } = input;
    const response = await f.request(body); assert.equal(response.status, 200);
    const output = await response.json();
    assert.deepEqual(output.content, [{ type: 'text', text: 'Updated native output' }]);
    assert.equal(output.usage.output_tokens, 999);
    assert.equal(f.usage[0].output_tokens, 4);
  }
});

test('output scripts skip token counting', async t => {
  const f = await fixture(t, { key: { output_script: 'async function updateOutput() { throw new Error("must not run"); }' }, fetch: () => json({ input_tokens: 50 }) });
  const { max_tokens, ...body } = input;
  const response = await f.request(body, '/v1/messages/count_tokens');
  assert.deepEqual(await response.json(), { input_tokens: 50 });
});


test('native SSE output scripts transform each event while preserving event names and usage', async t => {
  const f = await fixture(t, { key: { output_script: `async function updateOutput(output, type, context) {
    if (type !== 'ANTHROPIC') throw new Error('wrong protocol');
    if (output.delta?.thinking) output.delta.thinking = 'Changed';
    if (output.usage) output.usage.output_tokens = 999;
    return output;
  }` }, fetch: () => stream(events) });
  const response = await f.request({ ...input, stream: true });
  const text = await response.text();
  assert(text.includes('event: message_start'));
  assert(text.includes('event: ping'));
  assert(text.includes('event: message_stop'));
  assert(text.includes('"thinking":"Changed"'));
  assert.equal(f.usage[0].output_tokens, 8);
});


test('translated streams call updateOutput with Anthropic events after Chat translation', async t => {
  const chatEvents = [
    { id: 'chat-1', model: 'claude-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Original' }, finish_reason: null }] },
    { id: 'chat-1', model: 'claude-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } },
  ];
  const f = await fixture(t, { type: 'OPENAI_COMPATIBLE',
    key: { output_script: `async function updateOutput(output, type) {
      if (type !== 'ANTHROPIC' || typeof output.type !== 'string') throw new Error('untranslated');
      if (output.type === 'content_block_delta' && output.delta.type === 'text_delta') output.delta.text = 'Translated changed';
      return output;
    }` },
    fetch: () => new Response(chatEvents.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  });
  const { thinking, ...body } = input;
  const response = await f.request({ ...body, stream: true });
  const text = await response.text();
  assert(text.includes('Translated changed'));
  assert(text.includes('event: message_stop'));
  assert.equal(f.usage[0].output_tokens, 4);
});
