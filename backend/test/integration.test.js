import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { database } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { decrypt } from '../src/security/credentials.js';
import { DEFAULT_EVALUATION_SCRIPT } from '../src/services/evaluation-script.js';
const enabled = process.env.TEST_DB_NAME?.startsWith('infergate_test_');
test('real MySQL administration, routing, streaming, rejection and accounting', { skip: !enabled }, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, database: process.env.TEST_DB_NAME, timezone: 'Z' });
  const config = { encryptionKey: randomBytes(32), bootstrapToken: randomBytes(32).toString('hex'), modelDefault: 'DENY', bodyLimit: 10000, timeout: 1000 };
  let upstreamCalls = 0, upstreamAuth, mode = 'json', streamRelease;
  const upstream = createServer(async (req, res) => {
    upstreamCalls++; upstreamAuth = req.headers.authorization;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (mode === 'error') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '9' }); return res.end('{"error":{"message":"quota","type":"rate_limit_error"}}'); }
    if (mode === 'timeout') return;
    if (mode === 'stream' || mode === 'incomplete' || mode === 'cancel') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      if (mode === 'cancel') return;
      if (mode === 'stream') await new Promise(resolve => { streamRelease = resolve; });
      if (input.stream_options?.include_usage) res.write('data: {"model":"model-a","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n');
      if (mode === 'stream') res.write('data: [DONE]\n\n');
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'upstream-test' });
    res.end('{"id":"test","model":"model-a","usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const logs = [];
  const server = createApp(db, config, { log: value => logs.push(value) }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]); await db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`; let admin, proxy;
  async function call(path, method = 'GET', body, credential = admin, headers = {}) {
    return fetch(base + path, { method, headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  assert.equal((await call('/admin/users')).status, 401);
  assert.equal((await call('/admin/setup', 'POST', { password: 'secure-test-password' })).status, 403);
  assert.equal((await call('/admin/setup', 'POST', { password: 'secure-test-password' }, null, { 'x-bootstrap-token': config.bootstrapToken })).status, 201);
  assert.equal((await call('/admin/setup', 'POST', { password: 'replacement-password' }, null, { 'x-bootstrap-token': config.bootstrapToken })).status, 409);
  assert.equal((await call('/admin/login', 'POST', { password: 'wrong' })).status, 401);
  admin = (await (await call('/admin/login', 'POST', { password: 'secure-test-password' })).json()).token;
  const handlerResponse = await call('/admin/classification-handlers', 'POST', { name: 'Test classifier', description: 'Test configuration', api_url: 'https://classifier.example.com/classify', api_key: 'test-classification-secret' });
  assert.equal(handlerResponse.status, 201);
  const handler = await handlerResponse.json();
  const [storedHandler] = await db.query('SELECT encrypted_api_key,json_template FROM classification_handlers WHERE id=?', [handler.id]);
  assert.equal(decrypt(storedHandler.encrypted_api_key, config.encryptionKey), 'test-classification-secret');
  assert.deepEqual(storedHandler.json_template, { prompt: '${PROMPT}' });
  const handlerList = await (await call('/admin/classification-handlers')).json();
  assert.deepEqual(JSON.parse(handlerList.data[0].json_template), { prompt: '${PROMPT}' });
  assert(!JSON.stringify(handlerList).includes('test-classification-secret'));
  assert.equal((await call(`/admin/classification-handlers/${handler.id}`, 'PATCH', { json_template: '{ prompt: "invalid" }' })).status, 400);
  assert.equal((await call(`/admin/classification-handlers/${handler.id}`, 'PATCH', { description: 'Updated', json_template: '{"text":"${PROMPT}"}' })).status, 204);
  const user = await (await call('/admin/users', 'POST', { name: 'Test user', email: 'test@example.com' })).json();
  const provider = await (await call('/admin/providers', 'POST', { name: 'Mock', api_url: `http://127.0.0.1:${upstream.address().port}/v1` })).json();
  const dualResponse = await call('/admin/providers', 'POST', { name: 'Dual protocol', api_type: 'OPENAI_ANTHROPIC',
    api_url: 'https://openai.example/v1', anthropic_api_url: 'https://native.example/anthropic/v1' });
  assert.equal(dualResponse.status, 201);
  const dual = await dualResponse.json();
  const dualStored = await (await call(`/admin/providers/${dual.id}`)).json();
  assert.equal(dualStored.api_type, 'OPENAI_ANTHROPIC');
  assert.equal(dualStored.anthropic_api_url, 'https://native.example/anthropic/v1');
  assert.equal((await call(`/admin/providers/${dual.id}`, 'PATCH', { anthropic_api_url: null })).status, 204);
  assert.equal((await (await call(`/admin/providers/${dual.id}`)).json()).anthropic_api_url, null);
  assert.equal((await (await call(`/admin/providers/${provider.id}`)).json()).anthropic_api_url, null);
  const upstreamKey = await (await call('/admin/upstream-keys', 'POST', { provider_id: provider.id, name: 'Mock key', api_key: 'test-upstream-secret' })).json();
  const key = await (await call('/admin/proxy-keys', 'POST', { user_id: user.id, name: 'Test key' })).json(); proxy = key.api_key;
  assert.equal((await call('/admin/users', 'GET', undefined, proxy)).status, 401);
  assert(!(await (await call('/admin/upstream-keys')).text()).includes('test-upstream-secret'));
  const policies = [{ model_pattern: 'model-a', policy: 'ALLOW' }, { model_pattern: '*', policy: 'DENY' }];
  const role = await configureRole(call, '/admin', key.id, policies);
  const roleBefore = await (await call(`/admin/roles/${role.id}`)).json();
  assert.equal(roleBefore.classification_handler_id, null);
  const roleFields = { name: roleBefore.name, description: roleBefore.description, model_policy_id: roleBefore.model_policy_id, status: roleBefore.status };
  assert.equal((await call(`/admin/roles/${role.id}`, 'PUT', { ...roleFields, classification_handler_id: handler.id })).status, 204);
  assert.equal(String((await (await call(`/admin/roles/${role.id}`)).json()).classification_handler_id), String(handler.id));
  assert.equal((await (await call(`/admin/roles/${role.id}`)).json()).evaluation_script, DEFAULT_EVALUATION_SCRIPT);
  const customEvaluation = 'async function evaluate(input, input_type, classification, models, context) { return { category: "custom", sensitiveData: true, models: null }; }';
  assert.equal((await call(`/admin/roles/${role.id}`, 'PUT', { ...roleFields, evaluation_script: customEvaluation })).status, 204);
  assert.equal((await (await call(`/admin/roles/${role.id}`)).json()).evaluation_script, customEvaluation);
  assert.equal((await call(`/admin/roles/${role.id}`, 'PUT', { ...roleFields, classification_handler_id: '999999999999999999' })).status, 409);
  assert.equal((await call(`/admin/roles/${role.id}`, 'PUT', roleFields)).status, 204);
  assert.equal(String((await (await call(`/admin/roles/${role.id}`)).json()).classification_handler_id), String(handler.id));
  assert.equal((await call(`/admin/roles/${role.id}`, 'PUT', { ...roleFields, classification_handler_id: null })).status, 204);
  assert.equal((await (await call(`/admin/roles/${role.id}`)).json()).classification_handler_id, null);
  assert.equal((await (await call(`/admin/roles/${role.id}`)).json()).evaluation_script, customEvaluation);
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'model-a' }, proxy)).status, 503);
  assert.equal((await call(`/admin/roles/${role.id}/assignments`, 'PUT', [{ upstream_api_key_id: upstreamKey.id, priority: 10, status: 'ACTIVE' }])).status, 204);
  let response = await call('/v1/chat/completions', 'POST', { model: 'model-a' }, proxy);
  assert.equal(response.status, 200); assert.equal((await response.json()).usage.total_tokens, 12); assert.equal(upstreamAuth, 'Bearer test-upstream-secret');
  let count = upstreamCalls;
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'model-b' }, proxy)).status, 403);
  assert.equal((await call('/v1/batches', 'POST', { model: 'model-a', input_file_id: 'hidden' }, proxy)).status, 403);
  assert.equal((await call('/v1/responses/object-id', 'GET', undefined, proxy)).status, 403);
  assert.equal(upstreamCalls, count);
  await call(`/admin/users/${user.id}`, 'PATCH', { status: 'SUSPENDED' });
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'model-a' }, proxy)).status, 403);
  await call(`/admin/users/${user.id}`, 'PATCH', { status: 'ACTIVE' });
  await call(`/admin/providers/${provider.id}`, 'PATCH', { status: 'DISABLED' });
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'model-a' }, proxy)).status, 503);
  await call(`/admin/providers/${provider.id}`, 'PATCH', { status: 'ACTIVE' });
  await call(`/admin/upstream-keys/${upstreamKey.id}`, 'PATCH', { status: 'DISABLED' });
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'model-a' }, proxy)).status, 503);
  await call(`/admin/upstream-keys/${upstreamKey.id}`, 'PATCH', { status: 'ACTIVE' });
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'model-a', input: 'x'.repeat(11000) }, proxy)).status, 413);
  assert.equal((await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${proxy}`, 'content-type': 'application/json' }, body: '{broken' })).status, 400);
  assert.equal((await call(`/admin/roles/${role.id}/assignments`, 'PUT', [{ upstream_api_key_id: '999999', priority: 10, status: 'ACTIVE' }])).status, 409);
  const preserved = await (await call(`/admin/roles/${role.id}/assignments`)).json(); assert.equal(preserved.data.length, 1); assert.equal(preserved.data[0].upstream_api_key_id, upstreamKey.id);
  const group = await (await call('/admin/groups', 'POST', { name: 'Test group', description: 'Test membership' })).json();
  assert.equal((await call(`/admin/groups/${group.id}/users/${user.id}`, 'PUT')).status, 204);
  assert.equal((await (await call(`/admin/groups/${group.id}/users`)).json()).data.length, 1);
  const [storedKey] = await db.query('SELECT key_hash FROM proxy_api_keys WHERE id=?', [key.id]); assert.notEqual(storedKey.key_hash, proxy);
  const [storedUpstream] = await db.query('SELECT encrypted_api_key FROM upstream_api_keys WHERE id=?', [upstreamKey.id]); assert(!storedUpstream.encrypted_api_key.includes('test-upstream-secret'));
  mode = 'stream'; response = await call('/v1/chat/completions', 'POST', { model: 'model-a', stream: true }, proxy);
  const reader = response.body.getReader(); const first = await reader.read(); assert(Buffer.from(first.value).toString().includes('hello')); assert(streamRelease); streamRelease();
  let tail = ''; for (;;) { const next = await reader.read(); if (next.done) break; tail += Buffer.from(next.value); } assert(tail.includes('[DONE]'));
  mode = 'incomplete'; response = await call('/v1/chat/completions', 'POST', { model: 'model-a', stream: true }, proxy); await response.text();
  mode = 'error'; response = await call('/v1/chat/completions', 'POST', { model: 'model-a' }, proxy); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '9'); assert.equal((await response.json()).error.message, 'quota');
  mode = 'timeout'; response = await call('/v1/chat/completions', 'POST', { model: 'model-a' }, proxy); assert.equal(response.status, 504);
  mode = 'cancel'; response = await call('/v1/chat/completions', 'POST', { model: 'model-a', stream: true }, proxy); await response.body.cancel();
  for (let attempt = 0; attempt < 50; attempt++) { const [row] = await db.query("SELECT COUNT(*) AS n FROM api_requests WHERE request_status='CANCELLED'"); if (row.n) break; await new Promise(resolve => setTimeout(resolve, 20)); }
  const [cancelled] = await db.query("SELECT COUNT(*) AS n FROM api_requests WHERE request_status='CANCELLED'"); assert.equal(cancelled.n, 1);
  const events = await db.query('SELECT * FROM usage_events WHERE user_id=? ORDER BY id', [user.id]); assert.equal(events.length, 3); assert.equal(events[0].total_tokens, 12); assert.equal(events[0].reasoning_tokens, null); assert.equal(events[2].request_status, 'FAILED');
  assert(events.every(event => event.requestedModel === 'model-a'));
  assert(events.every(event => String(event.requestedProvider_id) === String(provider.id)));
  assert.equal(events[1].total_tokens, 5);
  const costs = await db.query('SELECT c.* FROM usage_costs c JOIN usage_events e ON e.id=c.usage_event_id WHERE e.user_id=?', [user.id]);
  assert.equal(costs.length, 3);
  const recent = await (await call(`/admin/requests?user_id=${user.id}`)).json();
  const withUsage = recent.data.find(request => request.id === events[0].api_request_id);
  assert.equal(withUsage.user_name, 'Test user');
  assert.equal(withUsage.model, 'model-a');
  assert.equal(withUsage.requestedModel, 'model-a');
  assert.equal(withUsage.category, null);
  assert.equal(withUsage.sensitive_data, null);
  assert.equal(withUsage.complexity, null);
  await assert.rejects(db.query('DELETE FROM usage_events WHERE id=?', [events[0].id]), { code: 'ER_ROW_IS_REFERENCED_2' });
  const summary = await (await call(`/admin/usage?group_by=user&user_id=${user.id}`)).json(); assert.equal(Number(summary.data[0].total_tokens), 22);
  assert.equal((await call('/admin/dashboard')).status, 200);
  await call(`/admin/proxy-keys/${key.id}/revoke`, 'POST');
  assert.equal((await call('/v1/chat/completions', 'POST', { model: 'model-a' }, proxy)).status, 401);
  assert(!JSON.stringify(logs).includes(proxy)); assert(!JSON.stringify(logs).includes('test-upstream-secret'));
  await call('/admin/logout', 'POST'); assert.equal((await call('/admin/users')).status, 401);
});

test('native adapters route across assignments and persist translated usage in MySQL', { skip: !enabled }, async t => {
  const { encrypt, digest } = await import('../src/security/credentials.js');
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, database: process.env.TEST_DB_NAME, timezone: 'Z' });
  const config = { encryptionKey: randomBytes(32), bootstrapToken: 'test-bootstrap', modelDefault: 'DENY', bodyLimit: 10000, timeout: 1000 };
  const calls = [];
  const app = createApp(db, config, { log() {}, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    const type = url.hostname.split('.')[0];
    if (type === 'classifier') return Response.json({ category: 'test' });
    if (type === 'anthropic') { assert.equal(init.headers.get('x-api-key'), 'native-anthropic'); assert.equal(init.headers.get('authorization'), null); }
    if (type === 'gemini') { assert.equal(init.headers.get('x-goog-api-key'), 'native-gemini'); assert.equal(init.headers.get('authorization'), null); }
    if (url.pathname.endsWith('/models')) {
      const value = type === 'anthropic' ? { data: [{ id: 'claude-test' }], has_more: false } : type === 'gemini' ? { models: [{ name: 'models/gemini-test' }] } : { object: 'list', data: [{ id: 'openai-test' }] };
      return Response.json(value);
    }
    assert.notEqual(type, 'openai');
    const body = JSON.parse(init.body);
    if (type === 'anthropic') {
      assert.equal(body.model, 'claude-test'); assert.equal(body.messages[0].content[0].text, 'Hello');
      const events = [
        { type: 'message_start', message: { id: 'msg_native', model: 'claude-test', usage: { input_tokens: 7, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' }
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    assert.equal(url.pathname, '/v1beta/models/gemini-test:streamGenerateContent');
    assert.equal(body.contents[0].parts[0].text, 'Hello');
    return new Response(`data: ${JSON.stringify({ modelVersion: 'gemini-test', candidates: [{ content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 12 } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); });
  const [anthropicDefault] = await db.query("SELECT api_type FROM llm_inference_providers WHERE name='Anthropic'"); assert.equal(anthropicDefault.api_type, 'ANTHROPIC');
  const [geminiDefault] = await db.query("SELECT api_type FROM llm_inference_providers WHERE name='Gemini'"); assert.equal(geminiDefault.api_type, 'GEMINI');
  const user = await db.query('INSERT INTO users(name,email) VALUES (?,?)', ['Native test', 'native@example.com']);
  const key = await db.query('INSERT INTO proxy_api_keys(user_id,name,key_hash,key_prefix) VALUES (?,?,?,?)', [user.insertId, 'Native proxy key', digest('pak_native_test'), 'pak_native']);
  const sharedPolicy = await db.query("INSERT INTO model_policies(name) VALUES (?)", [`Native policy ${key.insertId}`]);
  await db.query("INSERT INTO model_policy_rules(model_policy_id,model_pattern,policy) VALUES (?,'*','ALLOW')", [sharedPolicy.insertId]);
  const role = await db.query('INSERT INTO roles(name,model_policy_id) VALUES (?,?)', ['Native role',sharedPolicy.insertId]);
  await db.query('UPDATE proxy_api_keys SET role_id=? WHERE id=?', [role.insertId,key.insertId]);
  const ids = {};
  const providerIds = {};
  for (const [index, type] of ['OPENAI_COMPATIBLE','ANTHROPIC','GEMINI'].entries()) {
    const name = type === 'OPENAI_COMPATIBLE' ? 'openai' : type.toLowerCase();
    const provider = await db.query('INSERT INTO llm_inference_providers(name,api_url,api_type) VALUES (?,?,?)', [`Native test ${type}`, `https://${name}.example/${type === 'GEMINI' ? 'v1beta' : 'v1'}`, type]);
    const upstreamKey = await db.query('INSERT INTO upstream_api_keys(provider_id,name,encrypted_api_key,key_fingerprint) VALUES (?,?,?,?)', [provider.insertId, name, encrypt(`native-${name}`, config.encryptionKey), name]);
    ids[type] = upstreamKey.insertId;
    providerIds[type] = provider.insertId;
    await db.query('INSERT INTO role_upstream_assignments(role_id,upstream_api_key_id,priority) VALUES (?,?,?)', [role.insertId, upstreamKey.insertId, 10 - index]);
  }
  const base = `http://127.0.0.1:${server.address().port}`;
  const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer pak_native_test' } })).json();
  assert.deepEqual(models.data.map(model => model.id), ['openai-test','claude-test','gemini-test']);
  for (const model of ['claude-test','gemini-test']) {
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer pak_native_test', 'content-type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }], stream: true }) });
    assert.equal(response.status, 200); const text = await response.text(); assert(text.includes('[DONE]')); assert(!text.includes('"usage"'));
  }
  const events = await db.query('SELECT * FROM usage_events WHERE proxy_api_key_id=? ORDER BY id', [key.insertId]);
  assert.equal(events.length, 2);
  assert.equal(events[0].upstream_api_key_id, ids.ANTHROPIC); assert.equal(events[0].input_tokens, 7); assert.equal(events[0].output_tokens, 3); assert.equal(events[0].total_tokens, 10);
  assert.equal(events[1].upstream_api_key_id, ids.GEMINI); assert.equal(events[1].output_tokens, 5); assert.equal(events[1].reasoning_tokens, 2); assert.equal(events[1].total_tokens, 12);
  assert.equal(events[1].request_status, 'SUCCESS');
  const handler = await db.query('INSERT INTO classification_handlers(name,api_url,encrypted_api_key,key_fingerprint,json_template) VALUES (?,?,?,?,?)',
    ['Requested provider test', 'https://classifier.example/classify', encrypt('classifier-test', config.encryptionKey), 'classifier-test', JSON.stringify({ prompt: '${PROMPT}' })]);
  await db.query('UPDATE roles SET classification_handler_id=?,evaluation_script=? WHERE id=?', [handler.insertId,
    'async function evaluate() { return { category: "test", sensitiveData: false, models: ["claude-test"] }; }', role.insertId]);
  const rerouted = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer pak_native_test', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'openai-test', messages: [{ role: 'user', content: 'Hello' }], stream: true }) });
  assert.equal(rerouted.status, 200); await rerouted.text();
  const [event] = await db.query('SELECT * FROM usage_events WHERE proxy_api_key_id=? ORDER BY id DESC LIMIT 1', [key.insertId]);
  assert.equal(event.requestedModel, 'openai-test');
  assert.equal(event.requestedProvider_id, providerIds.OPENAI_COMPATIBLE);
  assert.equal(event.provider_id, providerIds.ANTHROPIC);
  assert.equal(event.model, 'claude-test');
});

test('Bedrock key regions are required, editable, used for routing and preserved in request history', { skip: !enabled }, async t => {
  const { token, digest } = await import('../src/security/credentials.js');
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, database: process.env.TEST_DB_NAME, timezone: 'Z' });
  const config = { encryptionKey: randomBytes(32), bootstrapToken: 'test-bootstrap', modelDefault: 'DENY', bodyLimit: 10000, timeout: 1000 };
  const admin = token('adm_'), calls = [];
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))', [digest(admin)]);
  const app = createApp(db, config, { log() {}, fetchImpl: async (url, init) => {
    calls.push({ url: url.href, init });
    const region = /^bedrock-mantle\.([a-z0-9-]+)\.api\.aws$/.exec(url.hostname)?.[1];
    assert(region); assert(init.headers.get('authorization').startsWith('Bearer bedrock-test-'));
    if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: `${region}-model`, object: 'model' }] });
    assert.equal(JSON.parse(init.body).model, `${region}-model`);
    return new Response(`data: ${JSON.stringify({ model: `${region}-model`, choices: [{ delta: { content: 'Hello' } }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.query('DELETE FROM admin_sessions WHERE token_hash=?', [digest(admin)]); await db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, method = 'GET', body, credential = admin) => fetch(base + path, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const options = await (await call('/admin/provider-options')).json(); assert(options.bedrock_regions.some(r => r.id === 'eu-central-1'));
  const providerList = (await (await call('/admin/providers')).json()).data;
  const bedrock = providerList.find(p => p.name === 'AWS Bedrock'); assert.equal(bedrock.api_type, 'AWS_BEDROCK');
  const other = providerList.find(p => p.name === 'OpenAI');
  for (const aws_region of [undefined, null, 'invalid', 'us-east-1.evil.example']) {
    assert.equal((await call('/admin/upstream-keys', 'POST', { provider_id: bedrock.id, name: 'Invalid Bedrock', api_key: 'bedrock-test-invalid', aws_region })).status, 400);
  }
  assert.equal((await call('/admin/upstream-keys', 'POST', { provider_id: other.id, name: 'Wrong provider', api_key: 'other-test', aws_region: 'eu-central-1' })).status, 400);
  const keys = [];
  for (const region of ['eu-central-1','us-east-1']) {
    const response = await call('/admin/upstream-keys', 'POST', { provider_id: bedrock.id, name: `Bedrock ${region}`, api_key: `bedrock-test-${region}`, aws_region: region });
    assert.equal(response.status, 201); const key = await response.json(); assert.equal(key.aws_region, region); assert(!JSON.stringify(key).includes('bedrock-test-')); keys.push(key);
  }
  const listed = await (await call('/admin/upstream-keys')).json(); assert.equal(listed.data.find(k => k.id === keys[0].id).aws_region, 'eu-central-1'); assert(!JSON.stringify(listed).includes('bedrock-test-'));
  assert.equal((await call(`/admin/providers/${bedrock.id}`, 'PATCH', { api_type: 'OPENAI_COMPATIBLE' })).status, 409);
  assert.equal((await call(`/admin/upstream-keys/${keys[0].id}`, 'PATCH', { aws_region: null })).status, 400);
  const user = await (await call('/admin/users', 'POST', { name: 'Bedrock user', email: 'bedrock@example.com' })).json();
  const proxy = await (await call('/admin/proxy-keys', 'POST', { name: 'Bedrock proxy', user_id: user.id })).json();
  const role = await configureRole(call, '/admin', proxy.id, [{ model_pattern: '*', policy: 'ALLOW' }]);
  await call(`/admin/roles/${role.id}/assignments`, 'PUT', keys.map((key, i) => ({ upstream_api_key_id: key.id, priority: 10 - i, status: 'ACTIVE' })));
  const models = await (await call('/v1/models', 'GET', undefined, proxy.api_key)).json(); assert.deepEqual(models.data.map(m => m.id), ['eu-central-1-model','us-east-1-model']);
  const infer = async region => {
    const response = await call('/v1/chat/completions', 'POST', { model: `${region}-model`, messages: [{ role: 'user', content: 'Hello' }], stream: true }, proxy.api_key);
    assert.equal(response.status, 200); assert((await response.text()).includes('[DONE]')); return response.headers.get('x-infergate-request-id');
  };
  const originalRequest = await infer('eu-central-1'); await infer('us-east-1');
  assert.equal((await call(`/admin/upstream-keys/${keys[0].id}`, 'PATCH', { aws_region: 'ap-south-1' })).status, 204);
  await infer('ap-south-1');
  const [historical] = await db.query('SELECT aws_region FROM api_requests WHERE request_id=?', [originalRequest]); assert.equal(historical.aws_region, 'eu-central-1');
  const requests = await db.query("SELECT aws_region,request_status FROM api_requests WHERE proxy_api_key_id=? AND endpoint='/v1/chat/completions' ORDER BY id", [proxy.id]);
  assert.deepEqual(requests.map(r => r.aws_region), ['eu-central-1','us-east-1','ap-south-1']); assert(requests.every(r => r.request_status === 'SUCCESS'));
  const usage = await db.query('SELECT total_tokens FROM usage_events WHERE proxy_api_key_id=?', [proxy.id]); assert.equal(usage.length, 3); assert(usage.every(e => e.total_tokens === 3));
});

test('shared roles apply policy edits and reject legacy writes', { skip: !enabled }, async t => {
  const { digest } = await import('../src/security/credentials.js');
  const { effectivePolicySql } = await import('../src/routes/model-policies.js');
  const { modelAllowed } = await import('../src/services/model-policy.js');
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, database: process.env.TEST_DB_NAME, timezone: 'Z' });
  const credential = 'adm_sharedpolicytest';
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))', [digest(credential)]);
  const server = createApp(db, { encryptionKey: randomBytes(32), modelDefault: 'DENY' }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); });
  const call = (path, method = 'GET', body, auth = credential) => fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, { method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal((await call('/model-policies', 'POST', {}, 'bad')).status, 401);
  const user = await (await call('/users', 'POST', { name: 'Policy owner', email: 'policy@example.test' })).json();
  const keys = [];
  for (const name of ['Shared A', 'Shared B']) keys.push(await (await call('/proxy-keys', 'POST', { name, user_id: user.id })).json());
  let body = { name: 'Shared policy test', description: 'Test', rules: [{ model_pattern: 'model-a', policy: 'ALLOW' }] };
  const created = await call('/model-policies', 'POST', body); assert.equal(created.status, 201);
  const policy = await created.json();
  const role = await (await call('/roles','POST',{name:'Shared test role',model_policy_id:policy.id})).json();
  for (const key of keys) assert.equal((await call(`/proxy-keys/${key.id}/role`, 'PUT', { role_id: role.id })).status, 204);
  for (const key of keys) assert(modelAllowed('model-a', await db.query(effectivePolicySql, [key.id])));
  body = { ...body, rules: [{ model_pattern: 'model-a', policy: 'DENY' }, { model_pattern: '*', policy: 'ALLOW' }] };
  assert.equal((await call(`/model-policies/${policy.id}`, 'PUT', body)).status, 204);
  for (const key of keys) {
    const rules = await db.query(effectivePolicySql, [key.id]);
    assert(!modelAllowed('model-a', rules)); assert(modelAllowed('model-b', rules));
  }
  assert.equal((await call(`/proxy-keys/${keys[0].id}/role`, 'PUT', { role_id: '99999999' })).status, 409);
  assert.equal(String((await (await call(`/proxy-keys/${keys[0].id}/role`)).json()).role_id), String(role.id));
  assert.equal((await call(`/model-policies/${policy.id}`, 'PUT', { ...body, rules: [{ model_pattern: 'bad*', policy: 'INVALID' }] })).status, 400);
  // Case-insensitive database uniqueness fails after DELETE, proving rollback preserves rules.
  assert.equal((await call(`/model-policies/${policy.id}`, 'PUT', { ...body, rules: [{ model_pattern: 'x', policy: 'ALLOW' }, { model_pattern: 'X', policy: 'ALLOW' }] })).status, 409);
  assert.equal((await (await call(`/model-policies/${policy.id}`)).json()).rules.length, 2);
  for (const endpoint of ['policies','model-policy','assignments']) assert.equal((await call(`/proxy-keys/${keys[0].id}/${endpoint}`, 'PUT', [])).status, 410);
  assert(modelAllowed('model-b', await db.query(effectivePolicySql, [keys[0].id])));
  assert(modelAllowed('model-b', await db.query(effectivePolicySql, [keys[1].id])));
  assert.equal((await call(`/proxy-keys/${keys[1].id}/role`, 'PUT', { role_id: null })).status, 204);
  assert.deepEqual(await db.query(effectivePolicySql, [keys[1].id]), []);
});

async function configureRole(call, prefix, keyId, rules) {
 const policyResponse = await call(`${prefix}/model-policies`,'POST',{name:`Role policy ${keyId}`,rules});
 assert.equal(policyResponse.status,201); const policy = await policyResponse.json();
 const response = await call(`${prefix}/roles`,'POST',{name:`Role ${keyId}`,model_policy_id:policy.id});
 assert.equal(response.status,201); const role = await response.json();
 assert.equal((await call(`${prefix}/proxy-keys/${keyId}/role`,'PUT',{role_id:role.id})).status,204);
 return role;
}
