import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createClient } from '@redis/client';
import { classificationCacheKey, createClassificationCache, validCachedClassification } from '../src/services/classification-cache.js';
import { classificationBody } from '../src/services/classification.js';
import { createModelCatalogue } from '../src/services/model-catalogue.js';
import { encrypt } from '../src/security/credentials.js';
import { config } from '../src/config.js';

const settings = { enabled: true, host: '127.0.0.1', port: 6379, database: 0, tls: false, timeoutMs: 100, ttlSeconds: 3600 };
const entry = { version: 1, model: 'model-a', category: 'other', sensitiveData: false, complexity: 0 };
test('cache key hashes the exact classification replacement, with role and configuration scope', () => {
  const role = { role_id: 7, classification_handler_id: 9, classification_config_hash: 'config-1', evaluation_script: 'script-1' };
  const messages = [{ role: 'assistant', content: 'ignored' }, { role: 'user', content: 'question' }, { role: 'system', content: 'instructions' }, { role: 'system', content: 'ignored' }, { role: 'user', content: 'follow-up' }];
  const key = classificationCacheKey(role, messages);
  assert(key.startsWith('infergate:classification:v5:'));
  assert(key.endsWith(createHash('md5').update(classificationBody('{"prompt":"${PROMPT}"}', messages).slice('{"prompt":"'.length, -2)).digest('hex')));
  assert(!key.includes('question'));
  assert.notEqual(key, classificationCacheKey(role, messages.slice(0, 3)));
  assert.equal(key, classificationCacheKey(role, messages.filter(message => message.role !== 'assistant')));
  assert.notEqual(key, classificationCacheKey(role, messages.filter(message => message.role !== 'system' || message.content !== 'ignored')));
  assert.notEqual(key, classificationCacheKey(role, messages.map(message => message.content === 'follow-up' ? { ...message, content: 'changed' } : message)));
  assert.notEqual(key, classificationCacheKey(role, [{role:'system',content:'instructions'}, {role:'user',content:'follow-up'}, {role:'user',content:'question'}]));
  for (const changed of [{ role_id: 8 }, { classification_handler_id: 10 }, { classification_config_hash: 'config-2' }, { evaluation_script: 'script-2' }, { role_updated_at: new Date() }])
    assert.notEqual(key, classificationCacheKey({ ...role, ...changed }, messages));
  assert.notEqual(classificationCacheKey(role, [{role:'system',content:'ab'},{role:'user',content:'c'}]), classificationCacheKey(role, [{role:'system',content:'a'},{role:'user',content:'bc'}]));
  for (const invalid of [undefined, null, {}, 'messages']) assert.equal(classificationCacheKey(role, invalid), null);
  for (const valid of [[], [{role:'user',content:'x'}], [{role:'system',content:'x'}], [{role:'system',content:null},{role:'user',content:'x'}], [{role:'user',content:null}], [{role:'assistant',content:'ignored'}, null]]) {
    const replacement = classificationBody('{"prompt":"${PROMPT}"}', valid).slice('{"prompt":"'.length, -2);
    assert(classificationCacheKey(role, valid).endsWith(createHash('md5').update(replacement).digest('hex')));
  }
  assert(classificationCacheKey(role, [{role:'system',content:[]},{role:'user',content:[{type:'text',text:'hello'}]}]));
});

test('prompt hash follows filtering, metadata, escaping and the configured cap exactly', () => {
  const role = { role_id: 7, classification_handler_id: 9 };
  const messages = [
    { role: 'system', content: 'Instructions', reasoning_content: 'excluded' },
    { role: 'user', name: 'Alice', content: 'Quotes " newline\n 🌻 \\'.repeat(2000), tool_calls: [] },
    { role: 'assistant', content: 'excluded' },
  ];
  for (const maxToken of [null, 100, 200, 30000]) {
    const body = classificationBody('{"prompt":"${PROMPT}"}', messages, maxToken);
    const replacement = body.slice('{"prompt":"'.length, -2);
    const key = classificationCacheKey({ ...role, classification_max_token: maxToken }, messages);
    assert(key.endsWith(createHash('md5').update(replacement).digest('hex')));
  }
  const key = classificationCacheKey(role, messages);
  assert.equal(key, classificationCacheKey(role, messages.map(message => ({ ...message, reasoning_content: 'changed', tool_calls: ['ignored'] }))));
  assert.notEqual(key, classificationCacheKey(role, messages.map(message => message.role === 'user' ? { ...message, name: 'Bob' } : message)));
  assert.equal(key, classificationCacheKey(role, messages.map(message => message.role === 'user' ? { ...message, content: message.content + 'outside default cap' } : message)));
  assert.notEqual(classificationCacheKey({ ...role, classification_max_token: 100 }, messages), classificationCacheKey({ ...role, classification_max_token: 200 }, messages));
});

test('cache uses atomic expiring Redis writes, validates entries, and falls back safely on errors', async () => {
  const values = new Map(), writes = [], logs = [];
  let connections = 0, destroyed = false, options, broken = false;
  const client = {
    isReady: false, isOpen: false, on() {},
    async connect() { connections++; this.isReady = true; this.isOpen = true; },
    withCommandOptions(commandOptions) {
      assert.equal(commandOptions.timeout, 100);
      return {
        get: async key => { if (broken) throw new Error('secret Redis connection details'); return values.get(key) ?? null; },
        set: async (key, value, expiry) => { writes.push(expiry); values.set(key, value); },
      };
    },
    destroy() { destroyed = true; this.isOpen = false; },
  };
  const cache = createClassificationCache(settings, { clientFactory: value => { options = value; return client; }, log: event => logs.push(event) });
  assert.equal(await cache.get('missing'), null);
  await cache.set('key', entry);
  assert.deepEqual(await cache.get('key'), entry);
  assert.equal(connections, 1); assert.equal(options.database, 0);
  assert.deepEqual(writes, [{ EX: 3600 }]);
  values.set('invalid', '{'); assert.equal(await cache.get('invalid'), null);
  values.set('invalid', JSON.stringify({ ...entry, sensitiveData: null })); assert.equal(await cache.get('invalid'), null);
  assert.equal(validCachedClassification({ ...entry, model: '' }), false);
  assert.equal(validCachedClassification({ ...entry, model: 12 }), false);
  assert.equal(validCachedClassification({ ...entry, sensitiveData: 'false' }), false);
  assert.equal(validCachedClassification(entry), true);
  for (const complexity of [undefined, null, 0, 1, 2]) assert.equal(validCachedClassification({ ...entry, complexity }), true);
  for (const complexity of [-1, 3, 1.5, '1', false]) assert.equal(validCachedClassification({ ...entry, complexity }), false);
  broken = true; assert.equal(await cache.get('key', { requestId: 'test-request' }), null);
  assert.deepEqual(logs, [{ event: 'classification_cache_unavailable', request_id: 'test-request' }]);
  cache.close(); assert(destroyed);
  assert.equal(createClassificationCache({ enabled: false }), null);
});

test('Redis environment settings default to a one-hour cache and validate input', () => {
  const env = { ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), BOOTSTRAP_TOKEN: 'x'.repeat(32) };
  assert.deepEqual(config(env).redis, { ...settings, username: '', password: '' });
  assert.equal(config({ ...env, REDIS_ENABLED: 'false' }).redis.enabled, false);
  assert.equal(config({ ...env, REDIS_DB: '5', REDIS_TLS: 'true' }).redis.database, 5);
  for (const invalid of [{REDIS_ENABLED:'yes'},{REDIS_DB:'-1'},{REDIS_PORT:'65536'},{CLASSIFICATION_CACHE_TTL_SECONDS:'0'},{REDIS_TIMEOUT_MS:'-1'}])
    assert.throws(() => config({ ...env, ...invalid }));
});

test('stalled Redis handshakes time out and fall back without hanging a request', async () => {
  let destroyed = false;
  const cache = createClassificationCache({...settings,timeoutMs:20}, { log() {}, clientFactory: () => ({
    isOpen:true, on() {}, connect: () => new Promise(() => {}), destroy() { destroyed = true; },
  }) });
  assert.equal(await cache.get('key'), null);
  assert(destroyed); cache.close();
});

test('real Redis stores cache entries in the configured database and expires them', { skip: process.env.TEST_REDIS !== '1' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'infergate-redis-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const redis = spawn('redis-server', ['--bind','127.0.0.1','--port',String(port),'--save','','--appendonly','no','--dir',directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (redis.exitCode === null) { const done = new Promise(resolve => redis.once('close', resolve)); redis.kill('SIGTERM'); await done; } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Redis startup timeout')), 5000);
    redis.once('error', error => { clearTimeout(timer); reject(error); });
    redis.once('exit', () => { clearTimeout(timer); reject(new Error('Redis exited before startup')); });
    redis.stdout.on('data', chunk => { if (chunk.toString().includes('Ready to accept connections')) { clearTimeout(timer); resolve(); } });
  });
  const options = { ...settings, port, database: 5, timeoutMs: 1000 };
  const cache = createClassificationCache(options); t.after(() => cache.close());
  const inspect = createClient({socket:{host:'127.0.0.1',port},database:5}); inspect.on('error',()=>{}); await inspect.connect(); t.after(()=>inspect.destroy());
  await cache.set('test-key',entry); assert.deepEqual(await cache.get('test-key'),entry);
  const ttl = await inspect.ttl('test-key'); assert(ttl > 3590 && ttl <= 3600);
  const expired = createClassificationCache({...options,ttlSeconds:1}); t.after(()=>expired.close());
  await expired.set('expiring',entry); assert.deepEqual(await expired.get('expiring'),entry);
  await new Promise(resolve=>setTimeout(resolve,1100)); assert.equal(await expired.get('expiring'),null);
  const encryptionKey = Buffer.alloc(32, 1);
  const catalogueConfig = { encryptionKey, redis: options, modelCatalogueCacheTtlSeconds: 1, timeout: 1000 };
  const assignment = { upstream_api_key_id: 1, provider_id: 2, api_url: 'https://example.test/v1', encrypted_api_key: encrypt('test-credential', encryptionKey) };
  let calls = 0;
  const fetchImpl = async () => { calls++; return Response.json({ data: [{ id: 'test-model' }] }); };
  const catalogues = createModelCatalogue(catalogueConfig, { fetchImpl }); t.after(() => catalogues.close());
  const second = createModelCatalogue(catalogueConfig, { fetchImpl }); t.after(() => second.close());
  await catalogues.get(assignment);
  assert.deepEqual(await (await second.get(assignment)).json(), { data: [{ id: 'test-model' }] });
  assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 1100));
  await second.get(assignment); assert.equal(calls, 2);
  const wrongDb = createClassificationCache({...options,database:0}); t.after(()=>wrongDb.close()); assert.equal(await wrongDb.get('test-key'),null);
});
