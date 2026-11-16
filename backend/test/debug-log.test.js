import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, stat, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ChatOutputCollector } from '../src/services/chat-output.js';
import { MessagesOutputCollector } from '../src/services/messages-output.js';
import { createDebugLogger } from '../src/services/debug-log.js';
import { createApp } from '../src/app.js';
import { encrypt } from '../src/security/credentials.js';

const debugIdentity = { user_id: 2, user_name: 'Test user', user_email: 'user@example.test', role_id: 7, role_name: 'Test role', upstream_id: 3, upstream_name: 'Test upstream key', proxy_api_key_id: 1, proxy_api_key_name: 'Test proxy key' };
function assertIdentity(metadata, selected = true) {
  for (const [key, value] of Object.entries(debugIdentity)) assert.equal(metadata[key], !selected && key.startsWith('upstream_') ? null : value, key);
}

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'infergate-debug-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('debug logger captures final split UTF-8 output, nullable usage, permissions and retention', async t => {
  const path = await directory(t);
  const expired = join(path, `${Date.now() - 61 * 86400000}-${randomUUID()}`);
  const retained = join(path, `${Date.now() - 59 * 86400000}-${randomUUID()}`);
  await mkdir(expired); await writeFile(join(expired, 'input.json'), 'old secret');
  await mkdir(retained);
  const record = { request_id: randomUUID(), started_at: new Date(), request_status: 'CANCELLED' };
  const logger = await createDebugLogger({ directory: path })(record, Buffer.from('{"messages":[{"content":"private input"}]}'));
  const bytes = Buffer.from('{"choices":[{"message":{"content":"€🌻"}}]}');
  await logger.push(bytes.subarray(0, 8)); await logger.push(bytes.subarray(8));
  await logger.finish(record, undefined, false);
  // 60-day retention: the 61-day-old directory is removed, the 59-day-old one is kept.
  const entries = await readdir(path);
  assert(!entries.includes(basename(expired))); assert(entries.includes(basename(retained))); assert.equal(entries.length, 2);
  const result = join(path, entries.find(name => name.endsWith(record.request_id)));
  assert.deepEqual((await readdir(result)).sort(), ['input.json', 'metadata.json']);
  assert((await readFile(join(result, 'input.json'), 'utf8')).includes('private input'));
  const metadata = JSON.parse(await readFile(join(result, 'metadata.json'), 'utf8'));
  assert.deepEqual(metadata.output, JSON.parse(bytes.toString()));
  assert.equal(metadata.usage, null); assert.equal(metadata.output_complete, false);
  for (const field of Object.keys(debugIdentity)) assert.equal(metadata[field], null);
  const usage = { input_tokens: 12, output_tokens: 8, total_tokens: 20, reasoning_tokens: null };
  const completeRecord = { ...record, request_id: randomUUID(), request_status: 'SUCCESS' };
  const complete = await createDebugLogger({ directory: path })(completeRecord, Buffer.from('{}'));
  await complete.push(Buffer.from('{}')); await complete.finish(completeRecord, usage, true);
  const completeEntry = (await readdir(path)).find(name => name.endsWith(completeRecord.request_id));
  assert.deepEqual(JSON.parse(await readFile(join(path, completeEntry, 'metadata.json'), 'utf8')).usage, usage);
  assert.equal((await stat(path)).mode & 0o777, 0o700);
  assert.equal((await stat(result)).mode & 0o777, 0o700);
  for (const file of ['input.json', 'metadata.json']) assert.equal((await stat(join(result, file))).mode & 0o777, 0o600);
});

test('disk errors log only a safe request ID and return without breaking inference', async t => {
  const path = await directory(t), events = [], record = { request_id: randomUUID() };
  await writeFile(join(path, 'blocked'), 'file');
  const logger = await createDebugLogger({ directory: join(path, 'blocked'), log: e => events.push(e) })(record, Buffer.from('secret'));
  assert.equal(logger, null);
  assert.deepEqual(events, [{ event: 'debug_log_write_failed', request_id: record.request_id }]);
});

test('evaluation log write errors are safe and do not prevent final debug metadata', async t => {
  const path = await directory(t), events = [], record = { request_id: randomUUID(), started_at: new Date() };
  const logger = await createDebugLogger({ directory: path, log: event => events.push(event) })(record, Buffer.from('{}'));
  const [entry] = await readdir(path);
  await mkdir(join(path, entry, 'evaluate.json'));
  await logger.evaluation({ category: 'private classification', sensitiveData: true, models: null });
  await logger.finish(record, undefined, false);
  assert.deepEqual(events, [{ event: 'debug_log_write_failed', request_id: record.request_id }]);
  assert((await readdir(join(path, entry))).includes('metadata.json'));
});

test('classification request write errors do not throw or expose request bodies', async t => {
  const path = await directory(t), events = [], record = { request_id: randomUUID(), started_at: new Date() };
  const logger = await createDebugLogger({ directory: path, log: event => events.push(event) })(record, Buffer.from('{}'));
  const [entry] = await readdir(path);
  await mkdir(join(path, entry, 'classification_req.json'));
  await logger.classificationRequest('{"prompt":"private message"}');
  await logger.finish(record, undefined, false);
  assert.deepEqual(events, [{ event: 'debug_log_write_failed', request_id: record.request_id }]);
  assert((await readdir(join(path, entry))).includes('metadata.json'));
});

async function fixture(t, options = {}) {
  const path = await directory(t), encryptionKey = randomBytes(32);
  let enabled = false, suspended = false;
  const logs = [];
  const db = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT token_hash')) return [{ token_hash: 'session' }];
      if (sql.startsWith('SELECT enabled')) return [{ enabled: Number(enabled) }];
      if (sql.startsWith('UPDATE debug_logging_settings')) { enabled = params[0]; return { affectedRows: 1 }; }
      if (sql.includes('FROM user_usage_limits')) return [];
      if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
      if (sql.includes('FROM proxy_api_keys k')) return [{ id: 1, proxy_api_key_name: 'Test proxy key', user_id: 2, user_name: 'Test user', user_email: 'user@example.test', role_id: 7, role_name: 'Test role', role_status: 'ACTIVE', model_policy_id: 8, status: 'ACTIVE', user_status: suspended ? 'SUSPENDED' : 'ACTIVE', classification_handler_id: options.classification ? 9 : null, evaluation_script: options.script }];
      if (sql.includes('FROM classification_handlers')) return [{ api_url: 'https://classifier.example', encrypted_api_key: encrypt('classifier-secret', encryptionKey), json_template: '{"prompt":"${PROMPT}"}' }];
      if (sql.includes('FROM role_model_policies')) return options.policies || [{ model_pattern: '*', policy: 'ALLOW' }];
      if (sql.includes('FROM role_upstream_assignments')) return [{ upstream_api_key_id: 3, upstream_name: 'Test upstream key', provider_id: 4, api_type: options.type, key_status: 'ACTIVE', provider_status: 'ACTIVE', api_url: 'https://mock.example/v1', encrypted_api_key: encrypt('upstream-secret', encryptionKey) }];
      if (sql.startsWith('UPDATE ') || sql.startsWith('INSERT ')) return { affectedRows: 1, insertId: 1 };
      if (sql.startsWith('SELECT ')) return [];
      throw new Error('Unexpected query');
    },
    transaction: fn => fn(db),
  };
  const input = { model: 'test', max_tokens: 100, messages: [{ role: 'user', content: 'complete private prompt' }] };
  const output = '{"model":"test","choices":[{"message":{"content":"complete answer"}}]}';
  const sse = 'data: {"model":"test","choices":[{"delta":{"content":"🌻"}}]}\n\ndata: [DONE]\n\n';
  const app = createApp(db, { encryptionKey, modelDefault: 'ALLOW', bodyLimit: 10000, timeout: options.timeout || 1000 }, {
    debugLogDirectory: path, log: e => logs.push(e),
    fetchImpl: async (url, init) => {
      // Model discovery runs before routing; answer it here so test upstreams only see inference calls.
      if (new URL(url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'test' }] });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      assert.equal(init.headers.get('authorization'), 'Bearer upstream-secret');
      const stream = JSON.parse(init.body).stream;
      return stream ? new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(sse.slice(0, 25))); c.enqueue(Buffer.from(sse.slice(25))); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }) : new Response(output, { headers: { 'content-type': 'application/json' } });
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const settings = (method = 'GET', body, auth = true) => fetch(`${base}/admin/settings/debug-logging`, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer adm_test' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const request = (stream = false, endpoint = '/v1/chat/completions', extra = {}) => fetch(`${base}${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer pak_test', 'content-type': 'application/json' }, body: JSON.stringify({ ...input, stream, ...extra }) });
  return { path, settings, request, output, sse, logs, suspend: (value = true) => { suspended = value; } };
}

test('logging settings require admin authentication and strict booleans', async t => {
  const f = await fixture(t);
  assert.equal((await f.settings('GET', undefined, false)).status, 401);
  assert.equal((await f.settings('PUT', { enabled: true }, false)).status, 401);
  assert.deepEqual(await (await f.settings()).json(), { enabled: false });
  for (const body of [{ enabled: 'true' }, { enabled: 1 }, {}, { enabled: null }, { enabled: true, extra: true }]) assert.equal((await f.settings('PUT', body)).status, 400);
  assert.deepEqual(await (await f.settings('PUT', { enabled: true })).json(), { enabled: true });
  assert.deepEqual(await (await f.settings()).json(), { enabled: true });
});

test('switch controls exact chat input/output capture without changing JSON or streams', async t => {
  const f = await fixture(t);
  assert.equal(await (await f.request()).text(), f.output);
  assert.deepEqual(await readdir(f.path), []);
  await f.settings('PUT', { enabled: true });
  assert.equal(await (await f.request()).text(), f.output);
  assert.equal(await (await f.request(true, '/v1/chat/completions/?test=1')).text(), f.sse);
  const entries = await readdir(f.path); assert.equal(entries.length, 2);
  const results = await Promise.all(entries.map(async entry => ({ input: await readFile(join(f.path, entry, 'input.json'), 'utf8'), metadata: JSON.parse(await readFile(join(f.path, entry, 'metadata.json'), 'utf8')) })));
  assert.deepEqual(results.find(r => !r.metadata.stream).metadata.output, JSON.parse(f.output));
  assert.equal(results.find(r => r.metadata.stream).metadata.output.choices[0].message.content, '🌻');
  for (const entry of entries) assert.deepEqual((await readdir(join(f.path, entry))).sort(), ['input.json', 'metadata.json', 'original_output.json']);
  for (const result of results) {
    assertIdentity(result.metadata);
    assert.equal(JSON.parse(result.input).messages[0].content, 'complete private prompt');
    assert.equal(result.metadata.output_complete, true);
    assert.equal(result.metadata.usage, null);
    assert(!JSON.stringify(result).includes('upstream-secret')); assert(!JSON.stringify(result).includes('pak_test'));
  }
  await (await f.request(false, '/v1/completions')).text();
  f.suspend(); assert.equal((await f.request()).status, 403);
  assert.equal((await readdir(f.path)).length, 2);
  await f.settings('PUT', { enabled: false });
  f.suspend(false);
  assert.equal(await (await f.request()).text(), f.output);
  assert.equal((await readdir(f.path)).length, 2);
  assert(!JSON.stringify(f.logs).includes('complete private prompt'));
});


test('streamed output combines choices, tool arguments, reasoning, and usage without keeping events', () => {
  const events = [
    { id: 'chat-test', model: 'test', choices: [{ index: 1, delta: { role: 'assistant', content: 'Second' } }, { index: 0, delta: { content: 'Hel', reasoning_content: 'Think', tool_calls: [{ index: 0, id: 'call-test', type: 'function', function: { name: 'lookup', arguments: '{"q":' } }] } }] },
    { choices: [{ index: 0, delta: { content: 'lo 🌻', reasoning_content: ' done', tool_calls: [{ index: 0, function: { arguments: '"value"}' } }] }, finish_reason: 'tool_calls' }, { index: 1, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } },
  ];
  const bytes = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  const collector = new ChatOutputCollector('text/event-stream');
  for (let offset = 0; offset < bytes.length; offset += 7) collector.push(bytes.subarray(offset, offset + 7));
  collector.finish();
  assert.equal(collector.output.object, 'chat.completion');
  assert.equal(collector.output.choices[0].message.content, 'Hello 🌻');
  assert.equal(collector.output.choices[0].message.reasoning_content, 'Think done');
  assert.deepEqual(collector.output.choices[0].message.tool_calls, [{ id: 'call-test', type: 'function', function: { name: 'lookup', arguments: '{"q":"value"}' } }]);
  assert.equal(collector.output.choices[0].finish_reason, 'tool_calls');
  assert.equal(collector.output.choices[1].message.content, 'Second');
  assert.deepEqual(collector.output.usage, events[2].usage);
  assert(!JSON.stringify(collector.output).includes('delta'));
});

test('diagnostic output bounds do not retain oversized responses; upstream errors remain visible', () => {
  const bounded = new ChatOutputCollector('application/json', 10);
  bounded.push(Buffer.from('{"content":"too large"}')); bounded.finish();
  assert.equal(bounded.output, null); assert.equal(bounded.truncated, true);
  const errors = new ChatOutputCollector('application/json');
  errors.push(Buffer.from('{"error":{"message":"quota"}}')); errors.finish();
  assert.deepEqual(errors.output, { error: { message: 'quota' } });
});

const nativeMessage = { id: 'msg_test', type: 'message', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'Hü 🌻' }, { type: 'thinking', thinking: 'Reason', signature: 'opaque' }, { type: 'tool_use', id: 'call_test', name: 'lookup', input: { key: 'value' } }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4, output_tokens_details: { thinking_tokens: 3 } } };
const nativeEvents = [
  { type: 'message_start', message: { ...nativeMessage, content: [], stop_reason: null, usage: { input_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 0 } } },
  { type: 'ping' },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hü 🌻' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'Reason' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'opaque' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_test', name: 'lookup', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"key":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"value"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 4, output_tokens_details: { thinking_tokens: 3 } } },
  { type: 'message_stop' },
];
const nativeSse = values => values.map(value => `event: ${value.type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`).join('');
const responseJson = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function debugResults(path) {
  return Promise.all((await readdir(path)).map(async entry => ({ entry, input: JSON.parse(await readFile(join(path, entry, 'input.json'), 'utf8')), metadata: JSON.parse(await readFile(join(path, entry, 'metadata.json'), 'utf8')) })));
}

test('Messages diagnostics assemble native UTF-8 text, thinking, signatures, tool JSON and final usage', () => {
  const collector = new MessagesOutputCollector('text/event-stream');
  for (const byte of Buffer.from(nativeSse(nativeEvents))) collector.push(Uint8Array.of(byte));
  collector.finish(); assert.deepEqual(collector.output, nativeMessage);
  assert(!JSON.stringify(collector.output).includes('content_block_delta'));
  const bounded = new MessagesOutputCollector('text/event-stream', 10);
  bounded.push(Buffer.from(nativeSse(nativeEvents))); bounded.finish(); assert.equal(bounded.output, null); assert.equal(bounded.truncated, true);
});

test('Messages diagnostics retain partial tool JSON, citations, sparse block indexes and stream errors', () => {
  const values = [nativeEvents[0], { type: 'content_block_start', index: Number.MAX_SAFE_INTEGER, content_block: { type: 'tool_use', id: 'call_test', name: 'lookup', input: {} } }, { type: 'content_block_delta', index: Number.MAX_SAFE_INTEGER, delta: { type: 'input_json_delta', partial_json: '{"key":' } }, { type: 'error', error: { type: 'api_error', message: 'stream failed' } }];
  const collector = new MessagesOutputCollector('text/event-stream'); collector.push(Buffer.from(nativeSse(values))); collector.finish();
  assert.equal(collector.output.content.length, 1); assert.equal(collector.output.content[0].partial_json, '{"key":'); assert.equal(collector.output.error.type, 'api_error');
  const citations = new MessagesOutputCollector('text/event-stream');
  citations.push(Buffer.from(nativeSse([nativeEvents[0], nativeEvents[2], { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'char_location', start_char_index: 1, end_char_index: 2 } } }]))); citations.finish();
  assert.equal(citations.output.content[0].citations[0].start_char_index, 1);
});

test('existing switch captures native and translated Messages JSON/SSE in request directories', async t => {
  for (const type of ['ANTHROPIC','OPENAI_COMPATIBLE']) for (const streamed of [false, true]) {
    const f = await fixture(t, { type, fetchImpl: async (url, init) => {
      assert.equal(init.headers.get(type === 'ANTHROPIC' ? 'x-api-key' : 'authorization'), type === 'ANTHROPIC' ? 'upstream-secret' : 'Bearer upstream-secret');
      if (type === 'ANTHROPIC') return streamed ? new Response(nativeSse(nativeEvents), { headers: { 'content-type': 'text/event-stream' } }) : responseJson(nativeMessage);
      const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, completion_tokens_details: { reasoning_tokens: 3 } };
      const value = { id: 'chat_test', model: 'test', choices: [{ index: 0, message: { role: 'assistant', content: 'Hü 🌻' }, finish_reason: 'stop' }], usage };
      return streamed ? new Response([{ id: 'chat_test', model: 'test', choices: [{ index: 0, delta: { content: 'Hü 🌻' }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, { choices: [], usage }, '[DONE]'].map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }) : responseJson(value);
    } });
    await (await f.request(streamed, '/v1/messages')).text(); assert.deepEqual(await readdir(f.path), []);
    await f.settings('PUT', { enabled: true });
    const response = await f.request(streamed, '/v1/messages/?beta=true', { system: 'private system' }); assert.equal(response.status, 200); await response.text();
    const [result] = await debugResults(f.path); assert.equal(result.input.system, 'private system'); assert.equal(result.input.messages[0].content, 'complete private prompt');
    assertIdentity(result.metadata);
    assert.equal(result.metadata.endpoint, '/v1/messages/'); assert.equal(result.metadata.http_method, 'POST');
    assert.equal(result.metadata.output.type, 'message'); assert.equal(result.metadata.output.content[0].text, 'Hü 🌻'); assert.equal(result.metadata.output_complete, true); assert.equal(result.metadata.usage.total_tokens, 14); assert.equal(result.metadata.usage.reasoning_tokens, 3);
    if (type === 'ANTHROPIC') assert.deepEqual(result.metadata.output, nativeMessage);
    assert.deepEqual((await readdir(join(f.path, result.entry))).sort(), ['input.json', 'metadata.json', 'original_output.json']);
    assert(!JSON.stringify(result).includes('upstream-secret')); assert(!JSON.stringify(result).includes('pak_test'));
    await f.settings('PUT', { enabled: false }); await (await f.request(streamed, '/v1/messages')).text(); assert.equal((await readdir(f.path)).length, 1);
    assert(!JSON.stringify(f.logs).includes('private system'));
  }
});

test('Messages classification and evaluation write the same optional diagnostic files', async t => {
  const f = await fixture(t, { type: 'ANTHROPIC', classification: true, script: 'async function evaluate() { return { category: "test", sensitiveData: false, models: null }; }', fetchImpl: async url => {
    if (String(url) === 'https://classifier.example') return responseJson({ category: 'test' });
    if (String(url).endsWith('/models')) return responseJson({ data: [{ id: 'test' }], has_more: false });
    return responseJson(nativeMessage);
  } });
  await f.settings('PUT', { enabled: true });
  await (await f.request(false, '/v1/messages', { system: 'private system' })).text();
  const [result] = await debugResults(f.path), files = await readdir(join(f.path, result.entry));
  assert.deepEqual(files.sort(), ['classification.json','classification_req.json','evaluate.json','input.json','metadata.json','original_output.json']);
  const classification = JSON.parse(await readFile(join(f.path, result.entry, 'classification_req.json'), 'utf8'));
  assert.deepEqual(JSON.parse(classification.prompt).map(message => message.role), ['system','user']);
  for (const file of files) { const value = await readFile(join(f.path, result.entry, file), 'utf8'); assert(!value.includes('classifier-secret')); assert(!value.includes('upstream-secret')); }
});

test('Messages logs policy and translation rejections but excludes suspended users and token counting', async t => {
  const f = await fixture(t, { type: 'ANTHROPIC', policies: [{ model_pattern: '*', policy: 'DENY' }] });
  await f.settings('PUT', { enabled: true }); assert.equal((await f.request(false, '/v1/messages')).status, 403);
  const [result] = await debugResults(f.path); assert.equal(result.metadata.output_complete, false); assert.equal(result.metadata.output, null); assert.equal(result.metadata.error_code, 'model_not_allowed');
  assertIdentity(result.metadata, false);
  f.suspend(); await (await f.request(false, '/v1/messages')).text(); assert.equal((await readdir(f.path)).length, 1);
  const count = await fixture(t, { type: 'ANTHROPIC', fetchImpl: async () => responseJson({ input_tokens: 5 }) });
  await count.settings('PUT', { enabled: true }); assert.equal((await count.request(false, '/v1/messages/count_tokens')).status, 200); assert.equal((await readdir(count.path)).length, 0);
  const translated = await fixture(t, { type: 'OPENAI_COMPATIBLE' }); await translated.settings('PUT', { enabled: true });
  assert.equal((await translated.request(false, '/v1/messages', { output_config: { effort: 'high' } })).status, 400);
  const [error] = await debugResults(translated.path); assert.equal(error.metadata.error_code, 'unsupported_messages_translation'); assert.equal(error.input.output_config.effort, 'high');
  assertIdentity(error.metadata);
});

test('Messages diagnostic capture retains partial output after an upstream timeout', async t => {
  const f = await fixture(t, { type: 'ANTHROPIC', timeout: 100, fetchImpl: async (url, init) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(Buffer.from(nativeSse(nativeEvents.slice(0, 4))));
    init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
  } }), { headers: { 'content-type': 'text/event-stream' } }) });
  await f.settings('PUT', { enabled: true }); const response = await f.request(true, '/v1/messages'); await assert.rejects(response.text());
  let results;
  for (let i = 0; i < 100; i++) { try { results = await debugResults(f.path); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
  assert.equal(results[0].metadata.output_complete, false); assert.equal(results[0].metadata.output.content[0].text, 'Hü 🌻'); assert.equal(results[0].metadata.error_code, 'upstream_timeout');
  assertIdentity(results[0].metadata);
});

test('Messages diagnostic output captures the returned sanitized provider error', async t => {
  const f = await fixture(t, { type: 'ANTHROPIC', fetchImpl: async () => new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'private provider diagnostics' } }), { status: 400, headers: { 'content-type': 'application/json' } }) });
  await f.settings('PUT', { enabled: true });
  const response = await f.request(false, '/v1/messages'); assert.equal(response.status, 400);
  const error = await response.json(), [result] = await debugResults(f.path);
  assert.deepEqual(result.metadata.output, error); assert.equal(result.metadata.request_status, 'FAILED');
  assertIdentity(result.metadata);
  assert.equal(result.metadata.error_code, 'upstream_400'); assert(!JSON.stringify(result).includes('private provider diagnostics'));
});
