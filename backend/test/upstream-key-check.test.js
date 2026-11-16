import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../src/security/credentials.js';
import { checkUpstreamKey } from '../src/services/upstream-key-check.js';
import { createApp } from '../src/app.js';
const config = { encryptionKey: randomBytes(32), timeout: 1000 };
const assignment = { api_type: 'OPENAI_COMPATIBLE', api_url: 'https://provider.example/v1', encrypted_api_key: encrypt('test-secret', config.encryptionKey) };

test('models check uses configured URL and credential and reports model count', async () => {
  const result = await checkUpstreamKey(assignment, config, { fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://provider.example/v1/models');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('authorization'), 'Bearer test-secret');
    assert.equal(init.redirect, 'manual');
    return Response.json({ data: [{ id: 'model-a' }] });
  }});
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.model_count, 1);
  assert(!JSON.stringify(result).includes('test-secret'));
});
test('models checks report safe HTTP, malformed response, network and timeout failures', async () => {
  for (const status of [401, 403, 404, 429, 500, 302]) {
    const result = await checkUpstreamKey(assignment, config, { fetchImpl: async () => new Response('test-secret', { status }) });
    assert.equal(result.status, 'FAILED'); assert.equal(result.http_status, status);
    assert(!JSON.stringify(result).includes('test-secret'));
  }
  const invalid = await checkUpstreamKey(assignment, config, { fetchImpl: async () => Response.json({ error: 'test-secret' }) });
  assert.equal(invalid.message, 'Provider returned an invalid model list');
  const network = await checkUpstreamKey(assignment, config, { fetchImpl: async () => { throw Error('test-secret'); } });
  assert.equal(network.status, 'FAILED'); assert(!JSON.stringify(network).includes('test-secret'));
  const timeout = await checkUpstreamKey(assignment, config, { signal: AbortSignal.abort(), fetchImpl: async (_, init) => { init.signal.throwIfAborted(); } });
  assert.equal(timeout.status, 'FAILED'); assert.match(timeout.message, /cancelled/);
});
test('admin check requires authentication and missing keys are not fetched', async t => {
  let calls = 0;
  const db = { query: async sql => sql.startsWith('SELECT token_hash') ? [{ token_hash: 'test' }] : [] };
  const server = createApp(db, config, { fetchImpl: async () => { calls++; } }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/admin/upstream-keys/1/check`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer adm_test' } })).status, 404);
  assert.equal(calls, 0);
});

test('upstream model listing is authenticated, fresh, deduplicated and sanitized', async t => {
  let calls = 0, failed = false;
  const db = { query: async (sql, params) => {
    if (sql.startsWith('SELECT token_hash')) return [{ token_hash: 'test' }];
    return params[0] === '1' ? [assignment] : [];
  } };
  const server = createApp(db, config, { fetchImpl: async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://provider.example/v1/models');
    assert.equal(init.headers.get('authorization'), 'Bearer test-secret');
    assert.equal(init.redirect, 'manual');
    if (failed) return new Response('private test-secret', { status: 401 });
    return Response.json({ data: [{ id: 'z', private_metadata: 'hidden' }, { id: 'a' }, { id: 'z' }] });
  } }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (id = '1', authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}/admin/upstream-keys/${id}/models`, {
    headers: authenticated ? { authorization: 'Bearer adm_test' } : {},
  });
  assert.equal((await call('1', false)).status, 401);
  assert.equal((await call('999')).status, 404);
  assert.equal(calls, 0);
  for (let i = 0; i < 2; i++) {
    const response = await call();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { data: [{ id: 'a' }, { id: 'z' }] });
  }
  assert.equal(calls, 2);
  failed = true;
  const response = await call();
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /private|test-secret/);
});
