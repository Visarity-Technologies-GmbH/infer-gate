import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../src/security/credentials.js';
import { config as readConfig } from '../src/config.js';
import { createModelCatalogue, modelCatalogueCacheKey, validCatalogue } from '../src/services/model-catalogue.js';
import { createJsonCache } from '../src/services/redis-cache.js';

function fixture(fetchImpl = async () => Response.json({ object: 'list', data: [{ id: 'a' }] })) {
  const config = { encryptionKey: randomBytes(32), timeout: 1000, modelCatalogueCacheTtlSeconds: 300 };
  const assignment = { upstream_api_key_id: 1, provider_id: 2, api_url: 'https://provider.example/v1', encrypted_api_key: encrypt('test-secret', config.encryptionKey) };
  let now = 0, calls = 0, broken = false;
  const values = new Map(), writes = [];
  const client = { isReady: false, isOpen: false, on() {}, async connect() { this.isReady = this.isOpen = true; }, destroy() { this.isOpen = false; },
    withCommandOptions() { return {
      async get(key) { if (broken) throw Error('secret'); const value = values.get(key); return value?.expires > now ? value.raw : null; },
      async set(key, raw, expiry) { if (broken) throw Error('secret'); writes.push(expiry); values.set(key, { raw, expires: now + expiry.EX * 1000 }); },
    }; },
  };
  const cache = createJsonCache({ enabled: true, timeoutMs: 100, ttlSeconds: 300 }, {
    validate: validCatalogue, maxBytes: 10 * 1024 * 1024, event: 'test', clientFactory: () => client, log() {},
  });
  const options = { cache, fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } };
  const service = createModelCatalogue(config, options);
  return { config, assignment, service, cache, values, writes, options, calls: () => calls, advance: ms => { now += ms; }, breakRedis: () => { broken = true; } };
}

test('Redis catalogue reuse across service instances, expiration, and refresh failure without stale fallback', async t => {
  let fail = false;
  const f = fixture(async () => fail ? Response.json({ error: { code: 'rate_limit' } }, { status: 429, headers: { 'retry-after': '5' } }) : Response.json({ data: [{ id: 'a' }] }, { headers: { 'x-request-id': 'fresh-id' } }));
  t.after(() => f.service.close());
  assert.equal((await f.service.get(f.assignment)).headers.get('x-request-id'), 'fresh-id');
  const other = createModelCatalogue(f.config, f.options);
  assert.deepEqual(await (await other.get(f.assignment)).json(), { data: [{ id: 'a' }] });
  assert.equal((await other.get(f.assignment)).headers.get('x-request-id'), null);
  assert.equal(f.calls(), 1); assert.deepEqual(f.writes, [{ EX: 300 }]);
  f.advance(300001); fail = true;
  const failed = await other.get(f.assignment); assert.equal(failed.status, 429); assert.equal(failed.headers.get('retry-after'), '5');
  assert.equal((await f.service.get(f.assignment)).status, 429); assert.equal(f.calls(), 3);
  fail = false; await f.service.get(f.assignment); assert.equal(f.calls(), 4);
});

test('cache identity isolates credentials, provider settings, upstream keys, regions and query parameters', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const key = modelCatalogueCacheKey(f.assignment, f.config);
  assert(!key.includes('test-secret'));
  for (const changed of [{ upstream_api_key_id: 3 }, { provider_id: 3 }, { api_url: 'https://other.example/v1' }, { api_type: 'ANTHROPIC' }, { aws_region: 'eu-central-1' }, { encrypted_api_key: encrypt('rotated', f.config.encryptionKey) }])
    assert.notEqual(key, modelCatalogueCacheKey({ ...f.assignment, ...changed }, f.config));
  assert.notEqual(key, modelCatalogueCacheKey(f.assignment, f.config, '/models?limit=1'));
  // Re-encrypting an unchanged credential must not bust the cache.
  assert.equal(key, modelCatalogueCacheKey({ ...f.assignment, encrypted_api_key: encrypt('test-secret', f.config.encryptionKey) }, f.config));
  const variable = 'INFERGATE_TEST_MODEL_CREDENTIAL';
  const original = process.env[variable]; t.after(() => { if (original === undefined) delete process.env[variable]; else process.env[variable] = original; });
  const referenced = { ...f.assignment, encrypted_api_key: encrypt(`$${variable}`, f.config.encryptionKey) };
  process.env[variable] = 'first'; const first = modelCatalogueCacheKey(referenced, f.config);
  process.env[variable] = 'second'; assert.notEqual(first, modelCatalogueCacheKey(referenced, f.config));
  delete process.env[variable]; assert.throws(() => modelCatalogueCacheKey(referenced, f.config), { code: 'upstream_credential_unavailable' });
});

test('concurrent misses share discovery; cancelling one waiter does not cancel the others', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(async (url, init) => { await gate; assert.equal(init.signal.aborted, false); return Response.json({ data: [{ id: 'a' }] }); });
  t.after(() => f.service.close());
  const controller = new AbortController();
  const cancelled = f.service.get(f.assignment, { signal: controller.signal });
  const pending = Array.from({ length: 10 }, () => f.service.get(f.assignment));
  controller.abort(); await assert.rejects(cancelled, { name: 'AbortError' }); release();
  for (const response of await Promise.all(pending)) assert.deepEqual(await response.json(), { data: [{ id: 'a' }] });
  assert.equal(f.calls(), 1);
});

test('invalid Redis entries and Redis failures fall back; malformed and network failures are not cached', async t => {
  let mode = 'normal';
  const f = fixture(async () => {
    if (mode === 'network') throw Error('network');
    return Response.json(mode === 'malformed' ? { data: [{}] } : { data: [{ id: 'a' }] });
  }); t.after(() => f.service.close());
  const key = modelCatalogueCacheKey(f.assignment, f.config);
  f.values.set(key, { raw: '{', expires: 1000 });
  await f.service.get(f.assignment); assert.equal(f.calls(), 1);
  f.advance(300001); mode = 'malformed';
  await assert.rejects(f.service.get(f.assignment), { code: 'invalid_model_list' });
  await assert.rejects(f.service.get(f.assignment), { code: 'invalid_model_list' });
  mode = 'network'; await assert.rejects(f.service.get(f.assignment), /network/);
  mode = 'normal'; f.breakRedis();
  await f.service.get(f.assignment); await f.service.get(f.assignment);
  assert.equal(f.calls(), 6);
});

test('model catalogue TTL has a separate five-minute default and rejects invalid settings', () => {
  const env = { ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), BOOTSTRAP_TOKEN: 'x'.repeat(32) };
  assert.equal(readConfig(env).modelCatalogueCacheTtlSeconds, 300);
  assert.equal(readConfig({ ...env, MODEL_CATALOGUE_CACHE_TTL_SECONDS: '60' }).modelCatalogueCacheTtlSeconds, 60);
  for (const value of ['0', '-1', '1.5', 'bad']) assert.throws(() => readConfig({ ...env, MODEL_CATALOGUE_CACHE_TTL_SECONDS: value }));
});

test('concurrent failed discovery responses can be consumed or cancelled without hanging', async t => {
  const f = fixture(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"error":"denied"}')); controller.close(); },
  }), { status: 401 }));
  t.after(() => f.service.close());
  const responses = await Promise.all(Array.from({ length: 3 }, () => f.service.get(f.assignment)));
  await responses[0].body.cancel();
  for (const response of responses.slice(1)) { assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: 'denied' }); }
  assert.equal(f.values.size, 0);
});
