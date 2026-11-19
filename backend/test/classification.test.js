import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classificationBody, classifyMessages } from '../src/services/classification.js';
import { encrypt } from '../src/security/credentials.js';
import { createApp } from '../src/app.js';
import { evaluatedModel } from '../src/services/routing.js';

test('prompt replacement serializes only messages as a string and escapes JSON safely', () => {
  const messages = [{ role: 'user', content: 'Quotes " newline\n backslash \\ 🌻 ${PROMPT} $&' }, { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }];
  const template = '{"prompt":"${PROMPT}","nested":["before ${PROMPT} after"],"other":true}';
  const result = JSON.parse(classificationBody(template, messages));
  assert.equal(result.prompt, JSON.stringify([messages[0]]));
  assert.deepEqual(JSON.parse(result.prompt), [messages[0]]);
  assert.equal(result.nested[0], `before ${JSON.stringify([messages[0]])} after`);
  assert.equal(result.other, true);
});

async function fixture(t, { enabled = true, assigned = true, deny = false, timeout = 1000, script, promptScript, inputScript, outputScript, sseOverride, expectedPrompt, expectedMessages, expectedTemperature = 0.3, includeUsage = false, usageOnRequest = false, modelIds = ['test-model'], expectedModel = 'test-model', policies, secondModelIds, inputMessages, classificationMessages, classificationCache, roleId = 7, classificationConfigHash = 'config-v1', maxToken = null } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'infergate-classification-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const encryptionKey = randomBytes(32), events = [], finalized = [], logs = [], usages = [], costs = [], classificationRequests = [];
  const messages = inputMessages ?? [{ role: 'user', content: 'private "prompt"\n🌻' }];
  const input = { model: 'test-model', messages, temperature: 0.3 };
  const result = { category: 'safe', score: 0.99 };
  let mode = 'success', suspended = false, resolveEntered, release;
  const entered = new Promise(resolve => { resolveEntered = resolve; });
  const db = {
    async query(sql) {
      if (sql.includes('FROM user_usage_limits')) return [];
      if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
      if (sql.includes('FROM proxy_api_keys k')) return [{ id: 1, user_id: 2, role_id: roleId, role_status: 'ACTIVE', role_debug_enabled: true, model_policy_id: 8, classification_handler_id: assigned ? 9 : null, classification_config_hash: classificationConfigHash, classification_max_token: maxToken, evaluation_script: script, prompt_script: promptScript, input_script: inputScript, output_script: outputScript, status: 'ACTIVE', user_status: suspended ? 'SUSPENDED' : 'ACTIVE' }];
      if (sql.includes('FROM classification_handlers')) return [{ api_url: 'https://classifier.example/classify', encrypted_api_key: encrypt('classifier-test-secret', encryptionKey), json_template: '{"prompt":"${PROMPT}","option":true}', maxToken }];
      if (sql.includes('FROM role_upstream_model_aliases')) return [];
      if (sql.includes('FROM role_model_policies')) { events.push('policy'); return policies ?? [{ model_pattern: '*', policy: deny ? 'DENY' : 'ALLOW' }]; }
      if (sql.includes('FROM role_upstream_assignments')) {
        const primary = { upstream_api_key_id: 3, provider_id: 4, key_status: 'ACTIVE', provider_status: 'ACTIVE', api_url: 'https://upstream.example/v1', api_type: 'OPENAI_COMPATIBLE', encrypted_api_key: encrypt('upstream-test-secret', encryptionKey) };
        return secondModelIds ? [primary, { ...primary, upstream_api_key_id: 5, provider_id: 6, api_url: 'https://second.example/v1' }] : [primary];
      }
      if (sql.startsWith('SELECT enabled')) return [{ enabled: Number(enabled) }];
      return { affectedRows: 1 };
    },
    async transaction(fn) {
      return fn({ query: async (sql, params) => {
        if (sql.includes('completed_at=')) finalized.push(params);
        if (sql.startsWith('INSERT INTO usage_events')) usages.push(params);
        if (sql.startsWith('INSERT INTO usage_costs')) costs.push(params);
        if (sql.startsWith('SELECT * FROM model_pricing')) return [];
        return { affectedRows: 1, insertId: 1 };
      } });
    },
  };
  const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
  const sse = sseOverride ?? 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n' + (includeUsage ? `data: ${JSON.stringify({ usage })}\n\n` : '') + 'data: [DONE]\n\n';
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://classifier.example')) {
      events.push('classification');
      classificationRequests.push(init.body);
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
      assert.equal(init.headers.get('authorization'), 'Bearer classifier-test-secret');
      assert.equal(init.headers.get('content-type'), 'application/json');
      assert.equal(init.headers.get('openai-beta'), null);
      assert.deepEqual(JSON.parse(init.body), { prompt: expectedPrompt ?? JSON.stringify(classificationMessages ?? messages).slice(0, Math.floor((maxToken ?? 30000) * 0.9)), option: true });
      if (mode === 'network') throw new Error('Sensitive classifier-test-secret transport detail');
      if (mode === 'wait' || mode === 'timeout') {
        resolveEntered();
        await new Promise((resolve, reject) => {
          release = resolve;
          init.signal.addEventListener('abort', () => { events.push('abort'); reject(new Error('aborted')); }, { once: true });
        });
      }
      if (mode === 'malformed') return new Response('private invalid response');
      if (mode === 'large') return new Response('x'.repeat(1024 * 1024 + 1));
      return Response.json(result, { status: mode === 'http' ? 503 : 200 });
    }
    assert.equal(init.headers.get('authorization'), 'Bearer upstream-test-secret');
    if (init.method === 'GET') { events.push('models'); return Response.json({ object: 'list', data: (String(url).startsWith('https://second.example') ? secondModelIds : modelIds).map(id => ({ id })) }); }
    events.push('upstream');
    assert.deepEqual(JSON.parse(init.body).messages, expectedMessages ?? messages);
    assert.equal(JSON.parse(init.body).temperature, expectedTemperature);
    assert.equal(JSON.parse(init.body).model, expectedModel);
    if (secondModelIds?.includes(expectedModel) && !modelIds.includes(expectedModel)) assert(String(url).startsWith('https://second.example'));
    const requestedUsage = usageOnRequest && JSON.parse(init.body).stream_options?.include_usage === true;
    const stream = requestedUsage ? `data: ${JSON.stringify({ usage })}\n\n${sse}` : sse;
    return JSON.parse(init.body).stream ? new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) : Response.json({ choices: [{ message: { content: 'Hi' } }], ...(includeUsage ? { usage } : {}) });
  };
  const server = createApp(db, { encryptionKey, modelDefault: 'DENY', bodyLimit: 10000, timeout }, { debugLogDirectory: path, classificationCache, fetchImpl, log: event => logs.push(event) }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (body = input, options = {}, endpoint = '/v1/chat/completions') => fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer pak_test', 'content-type': 'application/json', 'openai-beta': 'client-beta' }, body: JSON.stringify(body), ...options });
  const classified = async () => {
    const entries = await readdir(path);
    return Promise.all(entries.map(async entry => ({
      classification: JSON.parse(await readFile(join(path, entry, 'classification.json'), 'utf8')),
      metadata: JSON.parse(await readFile(join(path, entry, 'metadata.json'), 'utf8')),
      mode: (await stat(join(path, entry, 'classification.json'))).mode & 0o777,
    })));
  };
  return { path, request, classified, input, result, events, finalized, logs, usages, costs, classificationRequests, sse, entered, release: () => release(), mode: value => { mode = value; }, suspend: () => { suspended = true; }, setScript: value => { script = value; }, setPolicies: value => { policies = value; }, setHandlerConfig: value => { classificationConfigHash = value; } };
}

test('classification completes before policy and upstream, logs its result and preserves JSON and SSE', async t => {
  const f = await fixture(t);
  f.mode('wait');
  const pending = f.request();
  await f.entered;
  assert.deepEqual(f.events, ['classification']);
  f.release();
  assert.equal((await pending).status, 200);
  assert.deepEqual(f.events, ['classification', 'models', 'policy', 'upstream']);
  f.mode('success');
  assert.equal(await (await f.request({ ...f.input, stream: true })).text(), f.sse);
  const results = await f.classified();
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.deepEqual(result.classification, f.result);
    assert.equal(result.mode, 0o600);
    assert.equal(result.metadata.request_status, 'SUCCESS');
  }
  for (const entry of await readdir(f.path)) {
    const file = join(f.path, entry, 'evaluate.json');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { category: 'other', sensitiveData: false, complexity: 0, models: null });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const requestFile = join(f.path, entry, 'classification_req.json');
    const sent = await readFile(requestFile, 'utf8');
    assert(f.classificationRequests.includes(sent));
    assert.deepEqual(JSON.parse(sent), { prompt: JSON.stringify(f.input.messages), option: true });
    assert.equal((await stat(requestFile)).mode & 0o777, 0o600);
    assert(!sent.includes('classifier-test-secret'));
    assert(!sent.includes('pak_test'));
  }
  assert(!JSON.stringify(f.logs).includes('private'));
  assert(!JSON.stringify(f.logs).includes('classifier-test-secret'));
});

test('denied models are classified and logged before rejection without upstream forwarding', async t => {
  const f = await fixture(t, { deny: true });
  assert.equal((await f.request()).status, 403);
  assert.deepEqual(f.events, ['classification', 'models', 'policy']);
  const [result] = await f.classified();
  assert.deepEqual(result.classification, f.result);
  assert.equal(result.metadata.request_status, 'REJECTED');
  const [entry] = await readdir(f.path);
  assert.deepEqual(JSON.parse(await readFile(join(f.path, entry, 'evaluate.json'), 'utf8')), { category: 'other', sensitiveData: false, complexity: 0, models: null });
});

test('classification runs with logging disabled and is skipped for unassigned roles', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.events, ['classification', 'models', 'policy', 'upstream']);
  assert.deepEqual(await readdir(f.path), []);
  const unassigned = await fixture(t, { assigned: false, enabled: false });
  assert.equal((await unassigned.request()).status, 200);
  assert.deepEqual(unassigned.events, ['models', 'policy', 'upstream']);
  const skipped = await fixture(t, { assigned: false, enabled: true });
  assert.equal((await skipped.request()).status, 200);
  for (const entry of await readdir(skipped.path)) {
    const files = await readdir(join(skipped.path, entry));
    assert(!files.includes('evaluate.json'));
    assert(!files.includes('classification_req.json'));
  }
  f.suspend(); assert.equal((await f.request()).status, 403);
  assert.equal(f.events.filter(event => event === 'classification').length, 1);
});

test('classifier errors stop forwarding, use safe errors, and still finalize request tracking', async t => {
  for (const [mode, code, status] of [['network', 'classification_failed', 502], ['http', 'classification_http_error', 502], ['malformed', 'invalid_classification_response', 502], ['large', 'classification_response_too_large', 502], ['timeout', 'classification_timeout', 504]]) {
    await t.test(mode, async t => {
      const f = await fixture(t, { timeout: 50 }); f.mode(mode);
      const response = await f.request();
      assert.equal(response.status, status);
      const body = await response.json(); assert.equal(body.error.code, code);
      assert(!JSON.stringify(body).includes('classifier-test-secret'));
      assert(!JSON.stringify(body).includes('private'));
      assert(!f.events.includes('policy')); assert(!f.events.includes('upstream'));
      assert.equal(f.finalized[0][10], 'FAILED'); assert.equal(f.finalized[0][13], code);
      if (mode === 'http') assert.deepEqual((await f.classified())[0].classification, f.result);
      for (const entry of await readdir(f.path)) assert(!(await readdir(join(f.path, entry))).includes('evaluate.json'));
      for (const entry of await readdir(f.path)) assert.equal(await readFile(join(f.path, entry, 'classification_req.json'), 'utf8'), f.classificationRequests[0]);
    });
  }
});

test('disconnect aborts classification and records cancellation without forwarding', async t => {
  const f = await fixture(t, { timeout: 2000, enabled: false }); f.mode('wait');
  const controller = new AbortController();
  const pending = f.request(f.input, { signal: controller.signal });
  await f.entered; controller.abort(); await assert.rejects(pending);
  for (let i = 0; i < 100 && !f.finalized.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(f.events, ['classification', 'abort']);
  assert.equal(f.finalized[0][10], 'CANCELLED');
  assert.equal(f.finalized[0][13], 'client_disconnected');
});

test('classification requires an array of messages and a configured handler', async () => {
  const db = { query: async () => [] };
  for (const messages of [undefined, null, 'text', {}]) await assert.rejects(classifyMessages(db, 1, messages, {}), { status: 400, code: 'invalid_messages' });
  await assert.rejects(classifyMessages(db, 1, [], {}), { status: 503, code: 'classification_handler_unavailable' });
});

test('calls without messages skip classification; malformed chat messages fail before forwarding', async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.request(f.input, { method: 'GET', body: undefined }, '/v1/models')).status, 200);
  assert.deepEqual(f.events, ['policy', 'models']);
  for (const messages of [undefined, null, 'invalid', {}]) {
    assert.equal((await f.request({ ...f.input, messages })).status, 400);
  }
  assert.deepEqual(f.events, ['policy', 'models']);
});

test('evaluation runs after successful classification and its fields enter JSON and streaming usage events', async t => {
  const script = `async function evaluate(input, input_type, classification, models, context) {
    if (input.temperature !== 0.3 || classification.category !== 'safe' || models[0] !== 'test-model') throw new Error('Wrong inputs');
    input.model = 'different-model';
    return { category: 'financial', sensitiveData: true, complexity: 2, models: ['different-model'] };
  }`;
  const f = await fixture(t, { script, includeUsage: true, enabled: false });
  assert.equal((await f.request()).status, 200);
  assert.equal(await (await f.request({ ...f.input, stream: true })).text(), f.sse);
  assert.equal(f.usages.length, 2);
  for (const usage of f.usages) {
    assert.equal(usage[5], 'test-model');
    assert.equal(usage[14], 'financial');
    assert.equal(usage[15], true);
    assert.equal(usage[17], 2);
    assert.equal(usage[11], 6);
  }
  const defaultRole = await fixture(t, { includeUsage: true, enabled: false });
  assert.equal((await defaultRole.request()).status, 200);
  assert.equal(defaultRole.usages[0][17], 0);
  assert.equal(defaultRole.usages[0][14], 'other'); assert.equal(defaultRole.usages[0][15], false);
  const unassigned = await fixture(t, { assigned: false, includeUsage: true, enabled: false });
  assert.equal((await unassigned.request()).status, 200);
  assert.equal(unassigned.usages[0][17], null);
  assert.equal(unassigned.usages[0][14], null); assert.equal(unassigned.usages[0][15], null);
});

test('evaluation failure blocks policy and inference and creates no invented usage', async t => {
  const f = await fixture(t, { script: 'async function evaluate() { return {category: 12}; }', includeUsage: true, enabled: false });
  const response = await f.request();
  assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'invalid_evaluation_result');
  assert.deepEqual(f.events, ['classification', 'models']);
  assert.equal(f.usages.length, 0);
  assert.equal(f.finalized[0][10], 'FAILED');
  const noUsage = await fixture(t, { enabled: false });
  assert.equal((await noUsage.request()).status, 200);
  assert.equal(noUsage.usages.length, 0);
});

test('model candidates use exact IDs and candidate order; null, empty and no match retain the original', () => {
  const available = new Set(['model-b', 'model-a']);
  assert.equal(evaluatedModel('original', ['missing', 'model-a', 'model-b'], available), 'model-a');
  for (const candidates of [null, [], ['missing'], ['MODEL-A']])
    assert.equal(evaluatedModel('original', candidates, available), 'original');
});

test('evaluation reroutes to the first available candidate, preserves original input and accounts for the selected model', async t => {
  const script = `async function evaluate(input, input_type, classification, models, context) {
    if (input.model !== 'test-model') throw new Error('Original request lost');
    return { category: 'routed', sensitiveData: false, models: ['missing', 'alternate', 'second'] };
  }`;
  const f = await fixture(t, { script, includeUsage: true, modelIds: ['second', 'test-model', 'alternate'], expectedModel: 'alternate', policies: [{ model_pattern: 'test-model', policy: 'DENY' }, { model_pattern: 'alternate', policy: 'ALLOW' }, { model_pattern: '*', policy: 'DENY' }] });
  assert.equal((await f.request()).status, 200);
  assert.equal(await (await f.request({ ...f.input, stream: true })).text(), f.sse);
  for (const record of f.finalized) {
    assert.equal(record[4], 'test-model');
    assert.equal(record[5], 'alternate');
  }
  assert.equal(f.usages.length, 2);
  for (const usage of f.usages) {
    assert.equal(usage[5], 'alternate');
    assert.equal(usage[16], 'test-model'); assert.equal(usage[17], null);
  }
  const entries = await readdir(f.path);
  for (const entry of entries) {
    assert.equal(JSON.parse(await readFile(join(f.path, entry, 'input.json'), 'utf8')).model, 'test-model');
    assert.deepEqual(JSON.parse(await readFile(join(f.path, entry, 'evaluate.json'), 'utf8')), { category: 'routed', sensitiveData: false, complexity: null, models: ['missing', 'alternate', 'second'] });
  }
});

test('selected models still require authorization; a denied first match never falls through', async t => {
  const script = `async function evaluate() { return { category: 'routed', sensitiveData: false, models: ['blocked', 'allowed'] }; }`;
  const f = await fixture(t, { script, enabled: false, modelIds: ['blocked', 'allowed'], policies: [{ model_pattern: 'blocked', policy: 'DENY' }, { model_pattern: '*', policy: 'ALLOW' }] });
  const response = await f.request();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'model_not_allowed');
  assert.deepEqual(f.events, ['classification', 'models', 'policy']);
  assert.equal(f.finalized[0][4], 'test-model'); assert.equal(f.finalized[0][5], 'blocked');
  assert.equal(f.usages.length, 0);
});

test('evaluation model fallbacks retain normal forwarding', async t => {
  for (const models of [null, [], ['missing'], ['TEST-MODEL']]) {
    const script = `async function evaluate() { return { category: 'fallback', sensitiveData: false, models: ${JSON.stringify(models)} }; }`;
    const f = await fixture(t, { script, enabled: false, includeUsage: true });
    assert.equal((await f.request()).status, 200);
    assert.equal(f.usages[0][5], 'test-model');
    assert.equal(f.usages[0][16], 'test-model');
  }
});

test('evaluated model selects the provider offering it and reuses discovery results', async t => {
  const script = `async function evaluate(input, input_type, classification, models, context) {
    if (!models.includes('alternate')) throw new Error('Second provider missing');
    return { category: 'routed', sensitiveData: false, models: ['missing', 'alternate'] };
  }`;
  const f = await fixture(t, { script, includeUsage: true, enabled: false, secondModelIds: ['alternate'], expectedModel: 'alternate' });
  assert.equal((await f.request()).status, 200);
  assert.deepEqual(f.events, ['classification', 'models', 'models', 'policy', 'upstream']);
  assert.equal(f.finalized[0][2], 5); assert.equal(f.finalized[0][3], 6);
  assert.equal(f.usages[0][5], 'alternate');
  assert.equal(f.usages[0][16], 'test-model');
  assert.equal(f.usages[0][4], 6);
  assert.equal(f.usages[0][18], 4);
});

test('requested provider attribution handles routing priority, missing models and cache hits', async t => {
  for (const [modelIds, secondModelIds, expectedProvider] of [
    [['test-model'], ['alternate'], 4],
    [['test-model', 'alternate'], ['test-model'], 4],
    [['alternate'], ['test-model'], 6],
    [['alternate'], ['other'], null],
  ]) {
    const values = new Map();
    const classificationCache = { get: async key => values.get(key) ?? null, set: async (key, value) => values.set(key, value) };
    const f = await fixture(t, { classificationCache, enabled: false, includeUsage: true, modelIds, secondModelIds, expectedModel: 'alternate',
      script: `async function evaluate() { return { category: 'routed', sensitiveData: false, models: ['alternate'] }; }` });
    assert.equal((await f.request()).status, 200);
    f.mode('network');
    assert.equal(await (await f.request({ ...f.input, stream: true })).text(), f.sse);
    assert.equal(f.usages.length, 2);
    for (const usage of f.usages) {
      assert.equal(usage[4], modelIds.includes('alternate') ? 4 : 6);
      assert.equal(usage[18], expectedProvider);
    }
    assert.equal(f.events.filter(event => event === 'classification').length, 1);
  }
});

test('classification strips excluded roles, tool calls and reasoning without mutating messages', () => {
  const messages = [
    { role: 'system', content: 'Instructions', reasoning_content: 'private reasoning' },
    { role: 'user', content: [{ type: 'text', text: 'Question "🌻"' }], name: 'Alice' },
    { role: 'assistant', content: '\n\n', reasoning_content: 'hidden chain', tool_calls: [{ id: 'tool-1' }] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'huge tool output' },
    { role: 'function', content: 'legacy tool output' },
    { role: 'developer', content: 'excluded role' },
    { role: 'assistant', content: null, tool_calls: [] },
    null,
  ];
  const before = structuredClone(messages);
  for (const message of messages) if (message) Object.freeze(message);
  Object.freeze(messages);
  const result = JSON.parse(classificationBody('{"prompt":"${PROMPT}"}', messages));
  assert.deepEqual(JSON.parse(result.prompt), [
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: [{ type: 'text', text: 'Question "🌻"' }], name: 'Alice' },
  ]);
  assert.deepEqual(messages, before);
  assert.equal(JSON.parse(classificationBody('{"prompt":"${PROMPT}"}', [{ role: 'tool', content: 'output' }])).prompt, '[]');
});

test('only classification receives stripped messages; evaluation, inference and input logs retain originals', async t => {
  const inputMessages = [
    { role: 'system', content: 'System instructions' },
    { role: 'user', content: 'Can the Amiga OCS chipset display 256 colors?' },
    { role: 'assistant', content: '\n\n', reasoning_content: 'Look up color depth', tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'No files found' },
  ];
  const classificationMessages = [
    { role: 'system', content: 'System instructions' },
    { role: 'user', content: 'Can the Amiga OCS chipset display 256 colors?' },
  ];
  const script = `async function evaluate(input) {
    if (input.messages.length !== 4 || input.messages[3].role !== 'tool' || !input.messages[2].tool_calls || input.messages[2].reasoning_content !== 'Look up color depth') throw new Error('Original messages lost');
    return { category: 'hardware', sensitiveData: false, models: null };
  }`;
  const f = await fixture(t, { script, inputMessages, classificationMessages, includeUsage: true });
  assert.equal((await f.request()).status, 200);
  assert.equal(await (await f.request({ ...f.input, stream: true })).text(), f.sse);
  for (const entry of await readdir(f.path)) {
    const original = JSON.parse(await readFile(join(f.path, entry, 'input.json'), 'utf8'));
    assert.deepEqual(original.messages, inputMessages);
    const request = JSON.parse(await readFile(join(f.path, entry, 'classification_req.json'), 'utf8'));
    assert.deepEqual(JSON.parse(request.prompt), classificationMessages);
  }
  assert(f.usages.every(usage => usage[14] === 'hardware'));
});

test('cache hits reuse routed model and evaluation metadata without invoking classification or evaluation', async t => {
  const values = new Map();
  const classificationCache = { get: async key => values.get(key) ?? null, set: async (key, value) => values.set(key, value) };
  const inputMessages = [{ role: 'system', content: 'System instructions' }, { role: 'user', content: 'Question' }];
  const script = `async function evaluate() { return { category: 'cached', sensitiveData: false, complexity: 1, models: ['alternate'] }; }`;
  const f = await fixture(t, { classificationCache, inputMessages, script, modelIds: ['test-model', 'alternate'], expectedModel: 'alternate', includeUsage: true });
  assert.equal((await f.request()).status, 200);
  assert.equal(values.size, 1);
  const [cached] = values.values();
  assert.deepEqual(cached, { version: 1, model: 'alternate', category: 'cached', sensitiveData: false, complexity: 1 });
  // A classifier error on the next request would fail if it were called again.
  f.mode('network');
  assert.equal(await (await f.request({ ...f.input, stream: true })).text(), f.sse);
  assert.deepEqual(f.events, ['classification', 'models', 'policy', 'upstream', 'models', 'policy', 'upstream']);
  assert.equal(f.usages.length, 2);
  for (const usage of f.usages) {
    assert.equal(usage[5], 'alternate'); assert.equal(usage[14], 'cached'); assert.equal(usage[15], false); assert.equal(usage[16], 'test-model'); assert.equal(usage[17], 1);
  }
  let hits = 0;
  for (const entry of await readdir(f.path)) {
    const metadata = JSON.parse(await readFile(join(f.path, entry, 'metadata.json'), 'utf8'));
    if (metadata.classification_cache_hit) {
      hits++;
      assert.deepEqual((await readdir(join(f.path, entry))).sort(), ['input.json', 'metadata.json', 'original_output.json']);
    }
  }
  assert.equal(hits, 1);
  f.setPolicies([{ model_pattern: 'alternate', policy: 'DENY' }]);
  assert.equal((await f.request()).status, 403);
  assert.equal(f.events.filter(event => event === 'upstream').length, 2);
  f.suspend(); assert.equal((await f.request()).status, 403);
});

test('cache scopes isolate roles and invalidate script or handler changes', async t => {
  const values = new Map();
  const classificationCache = { get: async key => values.get(key) ?? null, set: async (key, value) => values.set(key, value) };
  const inputMessages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Question' }];
  const f = await fixture(t, { classificationCache, inputMessages, enabled: false });
  assert.equal((await f.request()).status, 200);
  f.setScript('async function evaluate() { return { category: "updated", sensitiveData: true, models: null }; }');
  assert.equal((await f.request()).status, 200);
  f.setHandlerConfig('config-v2');
  assert.equal((await f.request()).status, 200);
  const other = await fixture(t, { classificationCache, inputMessages, roleId: 99, enabled: false });
  assert.equal((await other.request()).status, 200);
  assert.equal(values.size, 4);
  assert.equal(f.events.filter(event => event === 'classification').length, 3);
  assert.equal(other.events.filter(event => event === 'classification').length, 1);
});

test('user-only prompts are cached, while denied or failed classifications are not', async t => {
  let reads = 0, writes = 0;
  const classificationCache = { get: async () => { reads++; return null; }, set: async () => { writes++; } };
  const missing = await fixture(t, { classificationCache, enabled: false });
  assert.equal((await missing.request()).status, 200); assert.equal(reads, 1); assert.equal(writes, 1);
  reads = 0; writes = 0;
  const inputMessages = [{ role: 'system', content: 'System' }, { role: 'user', content: 'Question' }];
  const denied = await fixture(t, { classificationCache, inputMessages, deny: true, enabled: false });
  assert.equal((await denied.request()).status, 403); assert.equal(writes, 0);
  const failed = await fixture(t, { classificationCache, inputMessages, enabled: false }); failed.mode('http');
  assert.equal((await failed.request()).status, 502); assert.equal(writes, 0);
});


test('classification caps prompt characters before JSON escaping with a nullable default', () => {
  const template = '{"prompt":"${PROMPT}"}';
  const messages = [{ role: 'user', content: '"\\'.repeat(20000) }];
  const full = JSON.stringify(messages);
  for (const [maxToken, limit] of [[null, 27000], [undefined, 27000], [100, 90], [11, 9], [1, 0]]) {
    const body = JSON.parse(classificationBody(template, messages, maxToken));
    assert.equal(body.prompt, full.slice(0, limit));
  }
  assert.equal(JSON.parse(classificationBody(template, [{ role: 'user', content: '🌻' }], 32)).prompt, '[{"role":"user","content":"');
});

test('classifier request uses the handler maxToken from the database', async () => {
  const encryptionKey = randomBytes(32);
  let sent;
  const db = { query: async sql => {
    assert(sql.includes('maxToken'));
    return [{ api_url: 'https://classifier.example/classify', encrypted_api_key: encrypt('secret', encryptionKey), json_template: '{"prompt":"${PROMPT}"}', maxToken: 100 }];
  } };
  const messages = [{ role: 'user', content: 'a'.repeat(200) }];
  await classifyMessages(db, 1, messages, { encryptionKey }, { fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body);
    return new Response('{}');
  } });
  assert.equal(sent.prompt, JSON.stringify(messages).slice(0, 90));
});


test('cache lookup hashes the actual capped replacement sent to the classifier', async t => {
  const keys = [];
  const inputMessages = [{ role: 'system', content: 'Instructions' }, { role: 'user', content: 'Question "quoted"'.repeat(40) }];
  const classificationCache = { get: async key => { keys.push(key); return null; }, set: async () => {} };
  const f = await fixture(t, { classificationCache, inputMessages, maxToken: 100, enabled: false });
  assert.equal((await f.request()).status, 200);
  const request = f.classificationRequests[0];
  const replacement = request.slice('{"prompt":"'.length, request.indexOf('","option":'));
  assert.equal(JSON.parse(request).prompt.length, 90);
  assert.equal(keys.length, 1);
  assert(keys[0].endsWith(createHash('md5').update(replacement).digest('hex')));
});


test('streaming chat requests collect usage and costs when the caller omits or disables usage', async t => {
  for (const stream_options of [undefined, { include_usage: false }, { include_usage: true }]) {
    const f = await fixture(t, { usageOnRequest: true });
    const response = await f.request({ ...f.input, stream: true, ...(stream_options ? { stream_options } : {}) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /"total_tokens":6/);
    assert.equal(f.usages.length, 1);
    assert.equal(f.usages[0][11], 6);
    assert.equal(f.usages[0][14], 'other');
    assert.equal(f.costs.length, 1);
    assert.equal(f.costs[0][0], 1);
    assert.equal(f.costs[0][8], 'UNPRICED');
    assert.equal(f.finalized[0][10], 'SUCCESS');
    const [debug] = await f.classified();
    assert.equal(debug.metadata.usage.total_tokens, 6);
    assert(!f.logs.some(event => event.event === 'accounting_write_failed'));
  }
});

test('custom OpenAI prompt runs once per request, shares context and uses the exact cache fragment', async t => {
  const values = new Map(), lookups = [];
  const cache = { async get(key) { lookups.push(key); return values.get(key); }, async set(key, value) { values.set(key, value); } };
  const f = await fixture(t, {
    enabled: false, includeUsage: true, classificationCache: cache,
    expectedPrompt: 'OPENAI:0.3:27000:1',
    promptScript: `async function prompt(input, type, limit, context) {
      context.calls = (context.calls || 0) + 1;
      context.category = type;
      const result = [type, input.temperature, limit, context.calls].join(':');
      input.messages = [];
      return result;
    }`,
    script: `async function evaluate(input, input_type, classification, models, context) {
      if (input_type !== 'OPENAI') throw new Error('wrong protocol');
      if (context.calls !== 1) throw new Error('prompt called more than once');
      return { category: context.category, sensitiveData: false, models: null };
    }`,
  });
  for (let i = 0; i < 2; i++) {
    const response = await f.request(); assert.equal(response.status, 200); await response.text();
  }
  assert.equal(f.events.filter(event => event === 'classification').length, 1);
  assert.equal(lookups.length, 2);
  assert.equal(lookups[0], lookups[1]);
  assert.equal([...values.values()][0].category, 'OPENAI');
});

test('prompt failure stops classification and inference without fallback', async t => {
  const f = await fixture(t, { enabled: false, promptScript: 'async function prompt() { throw new Error("private prompt"); }' });
  const response = await f.request();
  assert.equal(response.status, 502);
  const body = await response.text();
  assert(body.includes('prompt_failed'));
  assert(!body.includes('private prompt'));
  assert(!f.events.includes('classification'));
  assert(!f.events.includes('upstream'));
});

test('input scripts run after classification, share per-request prompt context on cache hits, and log exact output', async t => {
  const values = new Map();
  const cache = { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); } };
  const f = await fixture(t, {
    classificationCache: cache, expectedTemperature: 0.7,
    promptScript: 'async function prompt(input, type, limit, context) { context.type = type; return JSON.stringify(input.messages); }',
    script: 'async function evaluate(input, input_type, classification, models, context) { context.ready = true; return { category: "test", sensitiveData: false, models: null }; }',
    inputScript: `async function updateInput(input, type, context) {
      await Promise.resolve();
      // The prompt script runs on every request; evaluation context exists only on the cache miss.
      if (context.type !== type) throw new Error('missing shared context');
      input.temperature = 0.7;
      return input;
    }`,
  });
  for (let i = 0; i < 2; i++) {
    const response = await f.request(); assert.equal(response.status, 200); await response.text();
  }
  assert.equal(f.events.filter(event => event === 'classification').length, 1);
  assert.equal('context' in [...values.values()][0], false);
  for (const entry of await readdir(f.path)) {
    const outputPath = join(f.path, entry, 'update_input.json');
    assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), { ...f.input, temperature: 0.7 });
    assert.deepEqual(JSON.parse(await readFile(join(f.path, entry, 'input.json'), 'utf8')), f.input);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  }
});

test('input scripts run without classification, keep logging disabled and support model/stream changes', async t => {
  const f = await fixture(t, { enabled: false, assigned: false, expectedModel: 'alternate', modelIds: ['test-model', 'alternate'],
    inputScript: 'async function updateInput(input, type, context) { if (type !== "OPENAI" || context.user_id !== 2 || context.role_id !== 7 || typeof context.request_id !== "string" || Object.keys(JSON.parse(JSON.stringify(context))).sort().join() !== "request_id,role_id,user_id") throw new Error("bad context"); input.model = "alternate"; input.stream = true; return input; }' });
  const response = await f.request(); assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  await response.text();
  assert.deepEqual(await readdir(f.path), []);
  assert(!f.events.includes('classification'));
});

test('input scripts cannot send denied models or fall back after failure', async t => {
  for (const [inputScript, status] of [
    ['async function updateInput(input) { input.model = "blocked"; return input; }', 403],
    ['async function updateInput() { throw new Error("private input"); }', 502],
    ['async function updateInput() { return []; }', 502],
    ['async function updateInput(input) { input.messages = null; return input; }', 502],
    ['async function updateInput(input) { input.extra = "x".repeat(11000); return input; }', 502],
  ]) {
    const f = await fixture(t, { enabled: false, assigned: false, inputScript,
      policies: [{ model_pattern: 'test-model', policy: 'ALLOW' }] });
    const response = await f.request(); assert.equal(response.status, status);
    assert(!(await response.text()).includes('private input'));
    assert(!f.events.includes('upstream'));
  }
});


test('debug logging captures JSON and SSE originals without output scripts or classification', async t => {
  for (const stream of [false, true]) {
    const f = await fixture(t, { assigned: false, includeUsage: true });
    const response = await f.request({ ...f.input, stream });
    assert.equal(response.status, 200);
    const body = await response.text();
    const entries = await readdir(f.path);
    assert.equal(entries.length, 1);
    const path = join(f.path, entries[0], 'original_output.json');
    const original = JSON.parse(await readFile(path, 'utf8'));
    if (stream) {
      assert.equal(original[0].choices[0].delta.content, 'Hi');
      assert.equal(original[1].usage.total_tokens, 6);
      assert(body.endsWith('data: [DONE]\n\n'));
    } else {
      assert.deepEqual(original, JSON.parse(body));
      assert.equal(original.usage.total_tokens, 6);
    }
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert(!(await readdir(join(f.path, entries[0]))).includes('updated_output.json'));
  }
});

test('output scripts share per-request input context on cache hits, replace JSON and retain original accounting/debug output', async t => {
  const values = new Map();
  const f = await fixture(t, {
    includeUsage: true,
    classificationCache: { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); } },
    script: 'async function evaluate(input, input_type, classification, models, context) { context.fromEvaluation = true; return { category: "test", sensitiveData: false, models: null }; }',
    inputScript: 'async function updateInput(input, type, context) { context.fromInput = type; return input; }',
    outputScript: `async function updateOutput(output, type, context) {
      await Promise.resolve();
      if (context.fromInput !== type) throw new Error('missing context');
      output.choices[0].message.content = 'Updated';
      output.usage.total_tokens = 999;
      return output;
    }`,
  });
  for (let i = 0; i < 2; i++) {
    const response = await f.request(); assert.equal(response.status, 200);
    const output = await response.json();
    assert.equal(output.choices[0].message.content, 'Updated');
    assert.equal(output.usage.total_tokens, 999);
  }
  assert.equal(f.events.filter(event => event === 'classification').length, 1);
  for (const usage of f.usages) assert.equal(usage[11], 6);
  for (const entry of await readdir(f.path)) {
    const originalPath = join(f.path, entry, 'original_output.json');
    const original = JSON.parse(await readFile(originalPath, 'utf8'));
    assert.equal(original.choices[0].message.content, 'Hi');
    assert.equal(original.usage.total_tokens, 6);
    assert.equal((await stat(originalPath)).mode & 0o777, 0o600);
    const metadata = JSON.parse(await readFile(join(f.path, entry, 'metadata.json'), 'utf8'));
    assert.equal(metadata.output.choices[0].message.content, 'Updated');
    const updatedPath = join(f.path, entry, 'updated_output.json');
    assert.deepEqual(JSON.parse(await readFile(updatedPath, 'utf8')), metadata.output);
    assert.equal((await stat(updatedPath)).mode & 0o777, 0o600);
  }
});

test('output script failures keep consumed usage and original debug output without returning original body', async t => {
  const f = await fixture(t, { assigned: false, includeUsage: true,
    outputScript: 'async function updateOutput() { throw new Error("private output"); }' });
  const response = await f.request(); assert.equal(response.status, 502);
  const error = await response.text();
  assert(error.includes('output_script_failed')); assert(!error.includes('private output'));
  for (const entry of await readdir(f.path)) assert(!(await readdir(join(f.path, entry))).includes('updated_output.json'));
  assert.equal(f.usages[0][11], 6);
  const entries = await readdir(f.path);
  assert.equal(JSON.parse(await readFile(join(f.path, entries[0], 'original_output.json'), 'utf8')).choices[0].message.content, 'Hi');
});

test('output scripts work without classification/logging and transform SSE', async t => {
  const f = await fixture(t, { enabled: false, assigned: false,
    outputScript: 'async function updateOutput(output, type) { output.type = type; return output; }' });
  const response = await f.request(); assert.equal((await response.json()).type, 'OPENAI');
  assert.deepEqual(await readdir(f.path), []);
  const streamed = await f.request({ ...f.input, stream: true });
  const text = await streamed.text();
  assert(text.includes('"type":"OPENAI"'));
  assert(text.endsWith('data: [DONE]\n\n'));
});


test('stream output debug captures originals before scripts and accounts original usage', async t => {
  const f = await fixture(t, { assigned: false, includeUsage: true,
    outputScript: `async function updateOutput(output, type, context) {
      context.events = (context.events || 0) + 1;
      if (output.choices?.[0]?.delta) output.choices[0].delta.content = 'Changed';
      if (output.usage) output.usage.total_tokens = 999;
      return output;
    }` });
  const response = await f.request({ ...f.input, stream: true });
  const text = await response.text();
  assert(text.includes('Changed')); assert(text.includes('"total_tokens":999'));
  assert.equal(f.usages[0][11], 6);
  const entries = await readdir(f.path);
  const originalPath = join(f.path, entries[0], 'original_output.json');
  const originals = JSON.parse(await readFile(originalPath, 'utf8'));
  assert.equal(originals[0].choices[0].delta.content, 'Hi');
  assert.equal(originals[1].usage.total_tokens, 6);
  const updatedPath = join(f.path, entries[0], 'updated_output.json');
  const updated = JSON.parse(await readFile(updatedPath, 'utf8'));
  assert.equal(updated[0].choices[0].delta.content, 'Changed');
  assert.equal(updated[1].usage.total_tokens, 999);
  assert.equal(updated.length, originals.length);
  assert.equal((await stat(updatedPath)).mode & 0o777, 0o600);
  assert.equal((await stat(originalPath)).mode & 0o777, 0o600);
  const metadata = JSON.parse(await readFile(join(f.path, entries[0], 'metadata.json'), 'utf8'));
  assert.equal(metadata.output.choices[0].message.content, 'Changed');
});


test('stream script failure terminates delivery, retains upstream usage, and closes original debug JSON', async t => {
  const f = await fixture(t, { assigned: false, includeUsage: true,
    outputScript: 'async function updateOutput(output) { if (output.usage) throw new Error("private stream"); return output; }' });
  const response = await f.request({ ...f.input, stream: true });
  await assert.rejects(response.text());
  assert.equal(f.usages[0][11], 6);
  const entries = await readdir(f.path);
  const originals = JSON.parse(await readFile(join(f.path, entries[0], 'original_output.json'), 'utf8'));
  assert.equal(originals.length, 2);
  const updated = JSON.parse(await readFile(join(f.path, entries[0], 'updated_output.json'), 'utf8'));
  assert.deepEqual(updated, [originals[0]]);
  const metadata = JSON.parse(await readFile(join(f.path, entries[0], 'metadata.json'), 'utf8'));
  assert.equal(metadata.output_complete, false);
  assert.equal(metadata.error_code, 'output_script_failed');
});


test('identity output scripts succeed when an SDK closes immediately at finish_reason', async t => {
  const usage = { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 };
  const frames = [
    { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage },
  ];
  const f = await fixture(t, { assigned: false, enabled: false,
    outputScript: 'async function updateOutput(output, output_type, context) { return output; }',
    sseOverride: frames.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n',
  });
  const response = await f.request({ ...f.input, stream: true });
  const reader = response.body.getReader();
  let received = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += new TextDecoder().decode(value);
    if (received.includes('"finish_reason":"stop"')) {
      await reader.cancel();
      break;
    }
  }
  for (let i = 0; !f.logs.some(event => event.event === 'proxy_request') && i < 100; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  const record = f.logs.find(event => event.event === 'proxy_request');
  assert.equal(record?.status, 'SUCCESS');
  assert.equal(record.error_code, undefined);
  assert(received.includes('"total_tokens":6'));
  assert(received.endsWith('data: [DONE]\n\n'));
  assert.equal(f.usages[0][11], 6);
});

test('disconnecting before stream completion still records CANCELLED with an output script', async t => {
  const frames = [
    { choices: [{ delta: { content: 'First' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'Second' }, finish_reason: null }] },
  ];
  const f = await fixture(t, { assigned: false, enabled: false,
    outputScript: 'async function updateOutput(output, type, context) { context.calls = (context.calls || 0) + 1; if (context.calls > 1) await new Promise(() => {}); return output; }',
    sseOverride: frames.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n',
  });
  const response = await f.request({ ...f.input, stream: true });
  const reader = response.body.getReader();
  assert(new TextDecoder().decode((await reader.read()).value).includes('First'));
  await reader.cancel();
  for (let i = 0; !f.logs.some(event => event.event === 'proxy_request') && i < 100; i++)
    await new Promise(resolve => setTimeout(resolve, 10));
  const record = f.logs.find(event => event.event === 'proxy_request');
  assert.equal(record?.status, 'CANCELLED');
  assert.equal(record.error_code, 'client_disconnected');
});

// The classification cache stores only the routing decision. Script context is per request:
// it is never written to the cache and never restored from it.
const recordContext = name => `context.${name} = true;
      await context.logDebug('${name}_context.json', JSON.stringify(context));`;
async function loggedContexts(path) {
  const results = [];
  for (const entry of (await readdir(path)).sort()) {
    const read = async name => { try { return JSON.parse(await readFile(join(path, entry, name), 'utf8')); } catch { return null; } };
    // Request directories are named `${timestamp}-${request_id}`.
    results.push({ requestId: entry.slice(entry.indexOf('-') + 1), input: await read('input_context.json'), output: await read('output_context.json') });
  }
  return results;
}

test('classification cache entries never contain script context', async t => {
  const values = new Map();
  const f = await fixture(t, {
    includeUsage: true,
    classificationCache: { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); } },
    promptScript: 'async function prompt(input, type, limit, context) { context.fromPrompt = true; return JSON.stringify(input.messages); }',
    script: 'async function evaluate(input, input_type, classification, models, context) { context.fromEvaluation = true; return { category: "test", sensitiveData: false, complexity: 1, models: null }; }',
    inputScript: `async function updateInput(input, type, context) { ${recordContext('input')} return input; }`,
    outputScript: `async function updateOutput(output, type, context) { ${recordContext('output')} return output; }`,
  });
  for (let i = 0; i < 2; i++) { const response = await f.request(); assert.equal(response.status, 200); await response.text(); }
  assert.equal(f.events.filter(event => event === 'classification').length, 1);
  assert.equal(values.size, 1);
  assert.deepEqual([...values.values()][0], { version: 1, model: 'test-model', category: 'test', sensitiveData: false, complexity: 1 });
});

test('scripts on a classification cache hit see only the current request context', async t => {
  const values = new Map();
  const f = await fixture(t, {
    includeUsage: true,
    classificationCache: { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); } },
    promptScript: 'async function prompt(input, type, limit, context) { context.promptRequest = context.request_id; return JSON.stringify(input.messages); }',
    script: 'async function evaluate(input, input_type, classification, models, context) { context.fromEvaluation = true; return { category: "test", sensitiveData: false, models: null }; }',
    inputScript: `async function updateInput(input, type, context) { ${recordContext('input')} return input; }`,
    outputScript: `async function updateOutput(output, type, context) { ${recordContext('output')} return output; }`,
  });
  for (let i = 0; i < 2; i++) { const response = await f.request(); assert.equal(response.status, 200); await response.text(); }
  assert.equal(f.events.filter(event => event === 'classification').length, 1);
  const [miss, hit] = await loggedContexts(f.path);
  assert.notEqual(miss.requestId, hit.requestId);
  for (const [request, cacheHit] of [[miss, false], [hit, true]]) {
    for (const context of [request.input, request.output]) {
      // Gateway fields always describe the current request.
      assert.equal(context.user_id, 2); assert.equal(context.role_id, 7);
      assert.equal(context.request_id, request.requestId);
      // The prompt script runs on every request, so its fields belong to the current request too.
      assert.equal(context.promptRequest, request.requestId);
      // Evaluation does not run on a hit, and its context is not restored from the cache.
      assert.equal(context.fromEvaluation, cacheHit ? undefined : true);
    }
    assert.equal(request.output.input, true);
  }
});

test('legacy cache entries that carry a context never leak it into scripts', async t => {
  const legacy = { version: 1, model: 'test-model', category: 'cached', sensitiveData: false, complexity: 0,
    context: { user_id: 99, role_id: 99, request_id: 'foreign-request', foreign: 'other user data' } };
  const f = await fixture(t, {
    includeUsage: true,
    classificationCache: { async get() { return structuredClone(legacy); }, async set() { throw new Error('must not write on a hit'); } },
    inputScript: `async function updateInput(input, type, context) { ${recordContext('input')} return input; }`,
    outputScript: `async function updateOutput(output, type, context) { ${recordContext('output')} return output; }`,
  });
  const response = await f.request(); assert.equal(response.status, 200); await response.text();
  // The entry is still used for the routing decision.
  assert(!f.events.includes('classification'));
  assert.equal(f.usages[0][14], 'cached');
  const [request] = await loggedContexts(f.path);
  for (const context of [request.input, request.output]) {
    assert.equal(context.user_id, 2); assert.equal(context.role_id, 7);
    assert.equal(context.request_id, request.requestId);
    assert.equal(context.foreign, undefined);
  }
});
