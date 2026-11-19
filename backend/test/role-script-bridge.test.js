import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runRoleScript } from '../src/services/role-script-runner.js';

const run = (script, helpers = {}, options = {}) => runRoleScript({ mode: 'input', script,
  input: { model: 'test', messages: [] }, inputType: 'OPENAI', context: {} }, { helpers, ...options });

test('fetchJson posts JSON with authentication from every script type', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, headers: req.headers, body: JSON.parse(body) });
    res.end(JSON.stringify({ received: JSON.parse(body) }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const signatures = {
    prompt: 'prompt(input, type, limit, context)',
    evaluation: 'evaluate(input, type, classification, models, context)',
    input: 'updateInput(input, type, context)',
    output: 'updateOutput(input, type, context)',
  };
  for (const [mode, signature] of Object.entries(signatures)) {
    const result = await runRoleScript({ mode, input: { text: 'hello' }, context: {},
      script: `async function ${signature} {
        return await context.fetchJson(input, ${JSON.stringify(url)}, 'test-token');
      }` });
    assert.deepEqual(result.value, { received: { text: 'hello' } });
    assert.deepEqual(result.context, {});
  }
  assert.equal(requests.length, 4);
  for (const request of requests) {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer test-token');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers.accept, 'application/json');
    assert.deepEqual(request.body, { text: 'hello' });
  }
});

test('fetchJson preserves empty responses, JSON values and catchable error details', async t => {
  const server = createServer((req, res) => {
    const responses = {
      '/empty': [204, ''], '/value': [200, '[1,true,"text"]'],
      '/invalid': [200, 'invalid'], '/error': [422, '{"message":"Rejected","detail":123}'],
      '/fallback': [500, '{}'], '/error-field': [400, '{"error":"Bad request"}'],
    };
    const [status, body] = responses[req.url];
    res.writeHead(status).end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await run(`async function updateInput(input, type, context) {
    const results = {};
    for (const path of ['empty', 'value', 'invalid', 'error', 'fallback', 'error-field']) {
      try { results[path] = await context.fetchJson({}, ${JSON.stringify(url)} + '/' + path, 'token'); }
      catch (error) { results[path] = { message: error.message, status: error.status, response: error.response }; }
    }
    return results;
  }`);
  assert.deepEqual(result.value, {
    empty: null, value: [1, true, 'text'],
    invalid: { message: `Invalid JSON response from ${url}/invalid` },
    error: { message: 'Rejected', status: 422, response: { message: 'Rejected', detail: 123 } },
    fallback: { message: 'Request failed', status: 500, response: {} },
    'error-field': { message: 'Bad request', status: 400, response: { error: 'Bad request' } },
  });
});

test('fetchJson is cancelled when the script deadline expires', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const server = createServer((req, res) => { res.on('close', closed); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(run(`async function updateInput(input, type, context) {
    return await context.fetchJson({}, ${JSON.stringify(url)}, 'token');
  }`, {}, { scriptTimeouts: { totalMs: 300 } }), { code: 'evaluation_timeout' });
  await disconnected;
});

test('reported writeStringCache script completes after its helper reply', async () => {
  const calls = [];
  const result = await run(`async function updateInput(input, input_type, context) {
    try { await context.writeStringCache("test", "test"); } catch (error) {}
    return input;
  }`, { writeStringCache: async (...args) => { calls.push(args); return true; } });
  assert.deepEqual(calls, [['test', 'test']]);
  assert.deepEqual(result.value, { model: 'test', messages: [] });
});

test('sequential and concurrent helpers resume the script and preserve results', async () => {
  const values = new Map();
  const logs = [];
  const result = await run(`async function updateInput(input, type, context) {
    context.written = await context.writeStringCache('test', 'value');
    context.values = await Promise.all([context.readStringCache('test'), context.readStringCache('missing')]);
    await context.logDebug('script.txt', context.values[0]);
    context.hash = context.md5('abc');
    return input;
  }`, {
    writeStringCache: async (key, value) => { values.set(key, value); return true; },
    readStringCache: async key => values.get(key) ?? null,
    logDebug: async (...args) => { logs.push(args); return true; },
  });
  assert.deepEqual(result.context, { written: true, values: ['value', null], hash: '900150983cd24fb0d6963f7d28e17f72' });
  assert.deepEqual(logs, [['script.txt', 'value']]);
});

test('helper failures can be caught and unresolved helpers retain the deadline', async () => {
  const result = await run(`async function updateInput(input, type, context) {
    try { await context.writeStringCache('test', 'test'); }
    catch { context.caught = true; }
    return input;
  }`, { writeStringCache: async () => { throw new Error('private detail'); } });
  assert.equal(result.context.caught, true);
  await assert.rejects(run(`async function updateInput(input, type, context) {
    await context.readStringCache('test'); return input;
  }`, { readStringCache: () => new Promise(() => {}) }), { code: 'evaluation_timeout' });
});


test('fetchJson excludes overlapping HTTP waits from the script budget', async t => {
  const server = createServer((req, res) => {
    setTimeout(() => res.end('{"ok":true}'), req.url === '/slow' ? 1500 : 1100);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await run(`async function updateInput(input, type, context) {
    const results = await Promise.all([
      context.fetchJson({}, ${JSON.stringify(url)} + '/slow', 'token'),
      context.fetchJson({}, ${JSON.stringify(url)}, 'token')
    ]);
    results.push(await context.fetchJson({}, ${JSON.stringify(url)}, 'token'));
    return results;
  }`);
  assert.deepEqual(result.value, [{ ok: true }, { ok: true }, { ok: true }]);
});

test('fetchJson per-call timeout is catchable and covers response body reads', async t => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const result = await run(`async function updateInput(input, type, context) {
    try { await context.fetchJson({}, ${JSON.stringify(url)}, 'token'); }
    catch (error) { return { caught: true, message: error.message }; }
  }`, {}, { scriptTimeouts: { fetchMs: 100, totalMs: 2000 } });
  assert.equal(result.value.caught, true);
});

test('request cancellation interrupts a pending fetchJson', async t => {
  const controller = new AbortController();
  const server = createServer(() => controller.abort());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(run(`async function updateInput(input, type, context) {
    return await context.fetchJson({}, ${JSON.stringify(url)}, 'token');
  }`, {}, { signal: controller.signal }), { code: 'evaluation_timeout' });
});
