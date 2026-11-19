import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { encrypt } from '../src/security/credentials.js';
import { classificationCacheKey } from '../src/services/classification-cache.js';

const message = { id: 'resp_test', output: [] };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
async function fixture(t, options = {}) {
  const encryptionKey = randomBytes(32), calls = [], queries = [], usage = [], records = [];
  const key = { id: 1, user_id: 2, role_id: 7, role_status: 'ACTIVE', role_debug_enabled: true, model_policy_id: 8, status: 'ACTIVE', user_status: 'ACTIVE', ...options.key };
  const assignment = { upstream_api_key_id: 3, provider_id: 4, key_status: 'ACTIVE', provider_status: 'ACTIVE', api_type: options.type || 'ANTHROPIC', aws_region: options.region, anthropic_api_url: options.anthropicUrl, api_url: 'https://mock.example/v1', encrypted_api_key: encrypt('upstream-test-secret', encryptionKey) };
  const db = { async query(sql, params) {
    queries.push({ sql, params });
    if (sql.startsWith('SELECT enabled')) return [{ enabled: Number(Boolean(options.debugLogDirectory)) }];
    if (sql.includes('FROM user_usage_limits')) return options.cap ? [{ enabled: 1, period: 'DAILY', basis: 'TOKENS', token_limit: '1' }] : [];
    if (sql.includes('SUM(') && options.cap) return [{ consumed: '1' }];
    if (sql.startsWith('SELECT * FROM model_pricing')) return options.pricing ? [options.pricing] : [];
    if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
    if (sql.includes('FROM proxy_api_keys k')) return [key];
    if (sql.includes('FROM role_model_policies')) return options.policies || [{ model_pattern: 'claude-*', policy: 'ALLOW' }];
    if (sql.includes('FROM role_upstream_model_aliases')) return [];
    if (sql.includes('FROM role_upstream_assignments')) return [assignment];
    if (sql.includes('FROM classification_handlers')) return [{ api_url: 'https://classifier.example', encrypted_api_key: encrypt('classifier-secret', encryptionKey), json_template: '{"prompt":"${PROMPT}"}' }];
    if (sql.startsWith('INSERT INTO usage_events')) { usage.push(Object.fromEntries(sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((name, i) => [name, params[i]]))); return { insertId: 1 }; }
    if (sql.startsWith('UPDATE api_requests SET user_id=')) records.push(params);
    return { affectedRows: 1 };
  }, async transaction(fn) { return fn(db); } };
  const app = createApp(db, { encryptionKey, modelDefault: 'DENY', bodyLimit: options.bodyLimit || 10000, timeout: options.timeout || 5000 }, { log() {}, debugLogDirectory: options.debugLogDirectory, classificationCache: options.cache, fetchImpl: async (url, init) => {
    // Model discovery runs before routing; answer it here and keep `calls` limited to classifier/inference requests.
    if (new URL(url).pathname.endsWith('/models')) return json({ data: [{ id: 'claude-test' }, { id: 'claude-cheaper' }] });
    calls.push({ url: String(url), init }); return options.fetch ? options.fetch(url, init) : json(message);
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (body, path = '/v1/messages?beta=true', headers = {}, method = 'POST') => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'x-api-key': 'pak_client_test', 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'future-beta', ...headers }, body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { request, calls, usage, queries, records, key };
}

const evaluate = 'async function evaluate(input, input_type, classification, models, context) { if (input_type !== "OPENAI_RESPONSES" || input.instructions !== "Be brief") throw new Error("wrong input"); return {category:"responses", sensitiveData:false, models:["claude-cheaper"]}; }';
const requestBody = { model: 'claude-test', instructions: 'Be brief', input: 'Hello', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] };
const send = (f, body) => f.request(body, '/v1/responses', { authorization: 'Bearer pak_client_test' });

test('Responses normalizes input, isolates cache and remaps only model', async t => {
  const inputs = ['Hello', [{ role: 'user', content: [{ type: 'input_text', text: 'Hello' }] }, { type: 'function_call_output', call_id: 'call_1', output: 'ignore' }, { type: 'message', role: 'assistant', content: 'ignore assistant' }]];
  for (const input of inputs) {
    let classified, forwarded, cacheKey;
    const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: { classification_handler_id: 9, evaluation_script: evaluate,
      input_script: 'async function updateInput(input) { return input; }',
      output_script: 'async function updateOutput(output) { return output; }' },
      cache: { async get(key) { cacheKey = key; return null; }, async set() {} },
      fetch: (url, init) => {
        if (String(url).startsWith('https://classifier')) { classified = JSON.parse(JSON.parse(init.body).prompt); return json({}); }
        forwarded = JSON.parse(init.body); return json({ id: 'resp_test', output: [] });
      } });
    const body = { ...requestBody, input };
    const response = await send(f, body); assert.equal(response.status, 200); await response.text();
    const messages = [{ role: 'system', content: 'Be brief' }, { role: 'user', content: typeof input === 'string' ? input : input[0].content }];
    assert.deepEqual(classified, messages);
    assert.deepEqual(forwarded, { ...body, model: 'claude-cheaper' });
    assert.notEqual(cacheKey, classificationCacheKey(f.key, messages, undefined, undefined, {}, body));
  }
});

test('Responses prompt script receives original body and distinct input type', async t => {
  let prompt;
  const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: { classification_handler_id: 9, evaluation_script: evaluate,
    prompt_script: 'async function prompt(input, input_type, limit, context) { if (input_type !== "OPENAI_RESPONSES" || input.input !== "Hello" || input.tools[0].name !== "lookup") throw new Error("wrong input"); return "custom prompt"; }' },
    fetch: (url, init) => {
      if (String(url).startsWith('https://classifier')) { prompt = JSON.parse(init.body).prompt; return json({}); }
      return json({ output: [] });
    } });
  const response = await send(f, requestBody); assert.equal(response.status, 200); await response.text(); assert.equal(prompt, 'custom prompt');
});

test('Responses continuations bypass scripts and cache even with a messages field', async t => {
  for (const reference of [{ previous_response_id: 'resp_previous' }, { conversation: 'conv_previous' }]) {
    const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: { classification_handler_id: 9,
      prompt_script: 'async function prompt() { throw new Error("must not run"); }', evaluation_script: evaluate },
      cache: { async get() { throw new Error('must not read cache'); } } });
    const body = { ...requestBody, ...reference, messages: [{ role: 'user', content: 'nonstandard' }] };
    const response = await send(f, body); assert.equal(response.status, 200); await response.text();
    assert.equal(f.calls.length, 1); assert.deepEqual(JSON.parse(f.calls[0].init.body), body);
  }
});

test('Responses cached remapping still enforces model policy', async t => {
  for (const denied of [false, true]) {
    const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: { classification_handler_id: 9 },
      cache: { async get() { return { version: 1, model: 'claude-cheaper', category: 'cached', sensitiveData: false }; } },
      policies: [{ model_pattern: 'claude-*', policy: 'ALLOW' }, ...(denied ? [{ model_pattern: 'claude-cheaper', policy: 'DENY' }] : [])] });
    const response = await send(f, requestBody); assert.equal(response.status, denied ? 403 : 200); await response.text();
    assert.equal(f.calls.length, denied ? 0 : 1);
    if (!denied) assert.deepEqual(JSON.parse(f.calls[0].init.body), { ...requestBody, model: 'claude-cheaper' });
  }
});

test('Responses input/output hooks share context and preserve original usage', async t => {
  const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: {
    input_script: 'async function updateInput(input, input_type, context) { if (input_type !== "OPENAI_RESPONSES") throw Error(); context.tag = "shared"; return {...input, model:"claude-cheaper", input:"updated"}; }',
    output_script: 'async function updateOutput(output, input_type, context) { if (input_type !== "OPENAI_RESPONSES") throw Error(); return {...output, tag:context.tag, usage:{input_tokens:999, output_tokens:999,total_tokens:1998}}; }',
  }, fetch: () => json({ id: 'resp_test', output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }) });
  const response = await send(f, requestBody); assert.equal(response.status, 200);
  assert.equal((await response.json()).tag, 'shared');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { ...requestBody, model: 'claude-cheaper', input: 'updated' });
  assert.equal(f.usage[0].total_tokens, 5); assert.equal(f.usage[0].model, 'claude-cheaper');
  assert.equal(f.usage[0].requestedModel, 'claude-test');
});

test('Responses input validation and final authorization stop invalid scripts before inference', async t => {
  for (const [change, status] of [['model:"denied"',403], ['input:42',502], ['input:[null]',502], ['stream:"yes"',502], ['model:null',502]]) {
    const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: { input_script: `async function updateInput(input) { return {...input, ${change}}; }` } });
    const response = await send(f, requestBody); assert.equal(response.status, status); await response.text(); assert.equal(f.calls.length, 0);
  }
});

test('Responses continuation hooks run but cannot change models or references', async t => {
  for (const reference of [{ previous_response_id: 'resp_old' }, { conversation: { id: 'conv_old' } }]) {
    for (const change of ['instructions:"updated"', 'model:"claude-cheaper"', 'previous_response_id:null,conversation:null']) {
      const allowed = change.startsWith('instructions');
      const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: { classification_handler_id: 9,
        prompt_script: 'async function prompt() { throw Error(); }',
        input_script: `async function updateInput(input) { return {...input, ${change}}; }`,
        output_script: 'async function updateOutput(output) { return {...output, updated:true}; }' } });
      const response = await send(f, { ...requestBody, ...reference }); assert.equal(response.status, allowed ? 200 : 502);
      const result = await response.json();
      if (allowed) { assert.equal(result.updated, true); assert.deepEqual(JSON.parse(f.calls[0].init.body), { ...requestBody, ...reference, instructions: 'updated' }); }
      else assert.equal(f.calls.length, 0);
    }
  }
});

test('Responses output errors retain consumed usage', async t => {
  const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: { output_script: 'async function updateOutput() { throw Error("private"); }' },
    fetch: () => json({ output: [], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } }) });
  const response = await send(f, requestBody); assert.equal(response.status, 502); await response.text(); assert.equal(f.usage[0].total_tokens, 5);
});

test('Responses SSE transforms events, preserves framing and ends on original terminal events', async t => {
  for (const terminal of ['response.completed', 'response.failed', 'response.incomplete']) {
    const events = [{ type: 'response.output_text.delta', delta: 'hello' }, { type: terminal, response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }];
    const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: {
      output_script: 'async function updateOutput(output, input_type, context) { if (input_type !== "OPENAI_RESPONSES") throw Error(); context.count = (context.count || 0) + 1; return {...output, count:context.count, delta:output.delta?.toUpperCase(), response:output.response ? {...output.response, usage:{total_tokens:999}} : undefined}; }',
    }, fetch: () => new Response(new ReadableStream({ start(controller) {
      // Leave the upstream open: terminal recognition must finish delivery.
      controller.enqueue(new TextEncoder().encode(events.map((event, i) => `event: ${event.type}\nid: ${i}\ndata: ${JSON.stringify(event)}\n\n`).join('')));
    } }), { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await send(f, { ...requestBody, stream: true }); const text = await response.text();
    assert(text.includes('"delta":"HELLO"')); assert(text.includes(`event: ${terminal}\nid: 1`)); assert(text.includes('"count":2'));
    // Terminal delivery can precede the final accounting transaction.
    for (let i = 0; i < 50 && !f.usage.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.usage[0].total_tokens, 5);
    assert(f.records.some(record => record.includes(terminal === 'response.completed' ? 'SUCCESS' : 'FAILED')));
  }
});

test('Responses debug capture records input and original/updated JSON output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'responses-debug-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', debugLogDirectory: directory, key: {
    input_script: 'async function updateInput(input) { return {...input,input:"updated"}; }',
    output_script: 'async function updateOutput(output) { return {...output,tag:"updated"}; }',
  } });
  const response = await send(f, requestBody); assert.equal(response.status, 200); await response.text();
  const [entry] = await readdir(directory);
  const original = JSON.parse(await readFile(join(directory, entry, 'original_output.json'), 'utf8'));
  const updated = JSON.parse(await readFile(join(directory, entry, 'updated_output.json'), 'utf8'));
  assert.deepEqual(original, message); assert.deepEqual(updated, { ...message, tag: 'updated' });
});

test('Responses incomplete streams and stream script failures remain failed', async t => {
  for (const throws of [false, true]) {
    const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: {
      output_script: throws ? 'async function updateOutput() { throw Error(); }' : 'async function updateOutput(output) { return output; }',
    }, fetch: () => new Response('event: response.in_progress\ndata: {"type":"response.in_progress","response":{"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
    const response = await send(f, { ...requestBody, stream: true });
    try { await response.text(); } catch (error) { if (!throws) throw error; }
    for (let i = 0; i < 50 && !f.usage.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.usage[0].total_tokens, 5); assert(f.records.some(record => record.includes('FAILED')));
  }
});

test('Responses compacts system instructions before the input script', async t => {
  const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: {
    input_script: 'async function updateInput(input) { if (input.instructions !== "Be brief") throw Error(); return {...input, instructions: "Added   by script"}; }',
    system_prompt_compaction: { cleanWhitespace: true },
  } });
  const input = [{ role: 'developer', content: 'Keep   spacing' }, { role: 'system', content: 'Be   precise' }];
  const response = await send(f, { ...requestBody, instructions: 'Be   brief', input });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(JSON.parse(f.calls[0].init.body), {
    ...requestBody, instructions: 'Added   by script', input: [input[0], { role: 'system', content: 'Be precise' }],
  });
});

test('Responses classifier, cache, evaluation and remapping use compacted instructions', async t => {
  let cachedKey;
  const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', key: { classification_handler_id: 9,
    evaluation_script: evaluate, system_prompt_compaction: { cleanWhitespace: true } },
    cache: { async get(key) { cachedKey = key; return null; }, async set() {} },
    fetch: (url, init) => {
      if (String(url).startsWith('https://classifier')) {
        assert.equal(JSON.parse(JSON.parse(init.body).prompt)[0].content, 'Be brief');
        return json({});
      }
      assert.deepEqual(JSON.parse(init.body), { ...requestBody, model: 'claude-cheaper' });
      return json(message);
    } });
  const response = await send(f, { ...requestBody, instructions: 'Be   brief' });
  assert.equal(response.status, 200);
  await response.text();
  const firstKey = cachedKey;
  assert.ok(firstKey);
  const same = await send(f, requestBody);
  assert.equal(same.status, 200);
  await same.text();
  assert.equal(cachedKey, firstKey);
});

test('Responses logs the post-compaction body only for enabled options, including no-op passes', async t => {
  for (const [enabled, instructions] of [[true, 'Be   brief'], [true, 'Be brief'], [false, 'Be   brief']]) {
    const directory = await mkdtemp(join(tmpdir(), 'responses-compaction-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const f = await fixture(t, { type: 'OPENAI_COMPATIBLE', debugLogDirectory: directory,
      key: { system_prompt_compaction: { cleanWhitespace: enabled } } });
    const response = await send(f, { ...requestBody, instructions });
    assert.equal(response.status, 200);
    await response.text();
    const [entry] = await readdir(directory);
    const path = join(directory, entry, 'input_compacted.json');
    if (enabled) {
      const logged = await readFile(path, 'utf8');
      assert.equal(JSON.parse(logged).instructions, 'Be brief');
      assert.equal(logged, f.calls[0].init.body.toString());
    } else await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
});
