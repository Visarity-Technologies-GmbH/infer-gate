import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { encrypt, digest } from '../src/security/credentials.js';
import { createModelCatalogue } from '../src/services/model-catalogue.js';
import { filterModelList } from '../src/services/model-list.js';

const catalogue = { object: 'list', data: [
  { id: 'model-a', object: 'model', created: 123, owned_by: 'provider' },
  { id: 'model-b', object: 'model', created: 456, owned_by: 'provider' },
  { id: 'Model-A', object: 'model', created: 789, owned_by: 'provider' }
] };
async function fixture(t, options = {}) {
  const encryptionKey = randomBytes(32), queries = [], upstreamCalls = [];
  const policies = options.policies ?? [{ model_pattern: 'model-a', policy: 'ALLOW' }, { model_pattern: '*', policy: 'DENY' }];
  const db = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM user_usage_limits')) return [];
      if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
      if (sql.includes('FROM proxy_api_keys k')) {
        assert.equal(params[0], digest('pak_test'));
        return options.invalidKey ? [] : [{ id: 1, user_id: 2, role_id: 7, role_status: 'ACTIVE', model_policy_id: 8, status: options.keyStatus || 'ACTIVE', user_status: options.userStatus || 'ACTIVE' }];
      }
      if (sql.includes('FROM role_model_policies')) return policies;
      if (sql.includes('FROM role_upstream_model_aliases')) return [];
      if (sql.includes('FROM role_upstream_assignments')) {
        assert(sql.includes("a.status='ACTIVE'"));
        assert(sql.includes('ORDER BY a.priority DESC, a.id ASC'));
        assert(!sql.includes('LIMIT 1'));
        return options.noAssignment ? [] : (options.assignments || [{}]).map((row, index) => ({ upstream_api_key_id: index + 3, provider_id: 4, encrypted_api_key: encrypt(`upstream-test${index || ''}`, encryptionKey), key_status: options.upstreamStatus || 'ACTIVE', provider_status: options.providerStatus || 'ACTIVE', api_url: 'https://provider.example/v1', ...row }));
      }
      if (sql.startsWith('UPDATE ')) return { affectedRows: 1 };
      throw new Error(`Unexpected test query: ${sql}`);
    },
    async transaction(fn) { return fn(db); }
  };
  const config = { encryptionKey, bootstrapToken: 'test-bootstrap', modelDefault: options.fallback || 'DENY', bodyLimit: 10000, timeout: 1000 };
  const dependencies = {
    log() {},
    async fetchImpl(url, init) {
      upstreamCalls.push({ url: String(url), init });
      const index = upstreamCalls.length - 1;
      if (options.responses) {
        const item = options.responses[index];
        assert.equal(init.headers.get('authorization'), item.authorization);
        if (item.error) throw new Error('mock network failure');
        return new Response(JSON.stringify(item.body), { status: item.status || 200, headers: { 'content-type': 'application/json' } });
      }
      assert.equal(init.headers.get('authorization'), 'Bearer upstream-test');
      return new Response(options.raw ?? JSON.stringify(catalogue), { status: options.status || 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=1000', 'x-request-id': 'test-upstream', 'retry-after': '10' } });
    }
  };
  if (options.cache) dependencies.modelCatalogue = createModelCatalogue(config, { fetchImpl: dependencies.fetchImpl, cache: options.cache });
  const app = createApp(db, config, dependencies);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path = '/v1/models', method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { authorization: 'Bearer pak_test', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { request, queries, upstreamCalls };
}

test('restricted model listing uses assigned provider and preserves permitted model metadata', async t => {
  const f = await fixture(t);
  for (const path of ['/v1/models', '/v1/models/?limit=10']) {
    const response = await f.request(path);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { object: 'list', data: [catalogue.data[0]] });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-request-id'), 'test-upstream');
    assert(response.headers.get('x-infergate-request-id'));
  }
  assert.equal(f.upstreamCalls[1].url, 'https://provider.example/v1/models/?limit=10');
  assert(f.queries.some(q => q.sql.includes('completed_at=') && q.params.includes('SUCCESS')));
  assert(!f.queries.some(q => q.sql.includes('INSERT INTO usage_events')));
});

test('model listing follows exact deny, wildcard rules and system defaults', async t => {
  const cases = [
    { policies: [], expected: [] },
    // Listings are sorted by model ID (localeCompare): model-a, Model-A, model-b.
    { policies: [], fallback: 'ALLOW', expected: [catalogue.data[0], catalogue.data[2], catalogue.data[1]] },
    { policies: [{ model_pattern: '*', policy: 'ALLOW' }, { model_pattern: 'model-a', policy: 'DENY' }], expected: [catalogue.data[2], catalogue.data[1]] },
    { policies: [{ model_pattern: '*', policy: 'ALLOW' }, { model_pattern: 'model-a', policy: 'ALLOW' }, { model_pattern: 'model-a', policy: 'DENY' }], expected: [catalogue.data[2], catalogue.data[1]] },
    { policies: [{ model_pattern: 'not-in-provider', policy: 'ALLOW' }], expected: [] }
  ];
  for (const options of cases) {
    const f = await fixture(t, options), response = await f.request();
    assert.equal(response.status, 200); assert.deepEqual((await response.json()).data, options.expected);
  }
});

test('model listing retains authentication, suspension, revocation and routing checks', async t => {
  for (const [options, status] of [[{ invalidKey: true }, 401], [{ keyStatus: 'REVOKED' }, 401], [{ userStatus: 'SUSPENDED' }, 403], [{ noAssignment: true }, 503], [{ providerStatus: 'DISABLED' }, 503], [{ upstreamStatus: 'DISABLED' }, 503]]) {
    const f = await fixture(t, options);
    assert.equal((await f.request()).status, status); assert.equal(f.upstreamCalls.length, 0);
  }
});

test('listing exception does not authorize other models paths or methods', async t => {
  const f = await fixture(t);
  for (const [path, method] of [['/v1/models', 'POST'], ['/v1/models/model-b', 'GET'], ['/v1/batches', 'GET']]) assert.equal((await f.request(path, method)).status, 403);
  assert.equal(f.upstreamCalls.length, 0);
});

test('model catalogue upstream errors pass through; malformed success fails closed', async t => {
  const raw = '{"error":{"message":"quota","type":"rate_limit_error"}}';
  const f = await fixture(t, { status: 429, raw });
  const response = await f.request(); assert.equal(response.status, 429); assert.equal(await response.text(), raw); assert.equal(response.headers.get('retry-after'), '10');
  for (const raw of ['invalid-json', '{"data":{}}', '{"data":[{"name":"unknown"}]}']) {
    const invalid = await fixture(t, { raw }), response = await invalid.request();
    assert.equal(response.status, 502); assert.equal((await response.json()).error.code, 'invalid_model_list');
    assert(invalid.queries.some(q => q.sql.includes('completed_at=') && q.params.includes(502) && q.params.includes('FAILED')));
  }
});

test('oversized catalogues fail without returning an unfiltered list', async () => {
  await assert.rejects(filterModelList(new Response(JSON.stringify(catalogue)), [], 'ALLOW', 20), { status: 502, code: 'invalid_model_list' });
});


test('models from all assigned keys are merged, policy filtered and deduplicated in priority order', async t => {
  const f = await fixture(t, {
    assignments: [{}, {}, { provider_id: 5, api_url: 'https://second.example/v1' }],
    policies: [{ model_pattern: '*', policy: 'ALLOW' }, { model_pattern: 'denied', policy: 'DENY' }],
    responses: [
      { authorization: 'Bearer upstream-test', body: { object: 'list', data: [{ id: 'shared', owned_by: 'first' }, { id: 'first-only' }] } },
      { authorization: 'Bearer upstream-test1', body: { object: 'list', data: [{ id: 'shared', owned_by: 'second' }, { id: 'same-provider-other-key' }] } },
      { authorization: 'Bearer upstream-test2', body: { object: 'list', data: [{ id: 'other-provider' }, { id: 'denied' }] } }
    ]
  });
  const response = await f.request();
  assert.equal(response.status, 200);
  // Sorted by ID; the duplicate keeps the highest-priority upstream's metadata.
  assert.deepEqual(await response.json(), { object: 'list', data: [{ id: 'first-only' }, { id: 'other-provider' }, { id: 'same-provider-other-key' }, { id: 'shared', owned_by: 'first' }] });
  assert.equal(f.upstreamCalls.length, 3);
  assert.equal(f.upstreamCalls[2].url, 'https://second.example/v1/models');
  assert.equal(response.headers.get('x-request-id'), null);
  const finalized = f.queries.find(q => q.sql.includes('completed_at='));
  assert.equal(finalized.params[2], null); assert.equal(finalized.params[3], null);
  assert.equal(f.queries.filter(q => q.sql.startsWith('UPDATE upstream_api_keys')).length, 3);
});

test('disabled keys and providers are excluded even ahead of usable assignments', async t => {
  const f = await fixture(t, { assignments: [{ key_status: 'DISABLED' }, { provider_status: 'DISABLED' }, {}], responses: [
    { authorization: 'Bearer upstream-test2', body: catalogue }
  ] });
  const response = await f.request(); assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [catalogue.data[0]]);
  assert.equal(f.upstreamCalls.length, 1);
});

test('combined discovery skips a transient error and cools down the failing key', async t => {
  for (const status of [429, 503]) {
    const healthy = { authorization: 'Bearer upstream-test1', body: catalogue };
    const f = await fixture(t, { assignments: [{}, {}], responses: [
      { authorization: 'Bearer upstream-test', status, body: {} }, healthy, healthy
    ] });
    for (let i = 0; i < 2; i++) {
      const response = await f.request();
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, [catalogue.data[0]]);
    }
    assert.equal(f.upstreamCalls.length, 3);
  }
});

test('combined model listing skips rejected credentials and malformed catalogues in either position', async t => {
  for (const failure of [{ status: 401, body: {} }, { status: 403, body: {} }, { status: 404, body: {} }, { body: { data: {} } }]) {
    for (const failedIndex of [0, 1]) {
      const responses = [0, 1].map(index => ({
        authorization: index ? 'Bearer upstream-test1' : 'Bearer upstream-test',
        ...(index === failedIndex ? failure : { body: catalogue }),
      }));
      const f = await fixture(t, { assignments: [{}, {}], responses });
      const response = await f.request();
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).data, [catalogue.data[0]]);
      assert.equal(f.upstreamCalls.length, 2);
    }
  }
  const f = await fixture(t, { assignments: [{}, {}], responses: [
    { authorization: 'Bearer upstream-test', status: 401, body: {} },
    { authorization: 'Bearer upstream-test1', status: 403, body: {} },
  ] });
  assert.equal((await f.request()).status, 503);
});

test('Gemini 503 chat errors explain overload and persist a safe failure classification', async t => {
  const f = await fixture(t, { assignments: [{ api_type: 'GEMINI', api_url: 'https://provider.example/v1beta' }], responses: [
    // Model discovery runs before routing the chat request.
    { authorization: null, body: { models: [{ name: 'models/model-a' }] } },
    { authorization: null, status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand. private-prompt native-secret' } } }
  ] });
  const response = await f.request('/v1/chat/completions', 'POST', { model: 'model-a', messages: [{ role: 'user', content: 'Hello' }], stream: true });
  assert.equal(response.status, 503);
  const value = await response.json(); assert.equal(value.error.code, 'upstream_unavailable'); assert.equal(value.error.type, 'server_error'); assert(value.error.message.includes('high demand'));
  assert(!JSON.stringify(value).includes('private-prompt')); assert(!JSON.stringify(value).includes('native-secret'));
  const finalized = f.queries.find(q => q.sql.includes('completed_at='));
  assert.equal(finalized.params[9], 503); assert.equal(finalized.params[10], 'FAILED'); assert.equal(finalized.params[12], 'server_error'); assert.equal(finalized.params[13], 'upstream_unavailable');
  assert.equal(f.upstreamCalls.length, 2);
  assert.equal(f.upstreamCalls[0].url, 'https://provider.example/v1beta/models');
  assert.equal(f.upstreamCalls[1].url, 'https://provider.example/v1beta/models/model-a:streamGenerateContent?alt=sse');
});

test('cached catalogues are reused for listing while current policies and statuses still apply', async t => {
  const values = new Map();
  const cache = { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); } };
  const policies = [{ model_pattern: '*', policy: 'ALLOW' }];
  const options = { cache, policies };
  const f = await fixture(t, options);
  assert.equal((await f.request()).status, 200);
  policies.push({ model_pattern: 'model-a', policy: 'DENY' });
  assert.deepEqual((await (await f.request()).json()).data.map(m => m.id), ['Model-A', 'model-b']);
  assert.equal(f.upstreamCalls.length, 1);
  options.userStatus = 'SUSPENDED'; assert.equal((await f.request()).status, 403);
  options.userStatus = 'ACTIVE'; options.keyStatus = 'REVOKED'; assert.equal((await f.request()).status, 401);
  options.keyStatus = 'ACTIVE'; options.providerStatus = 'DISABLED'; assert.equal((await f.request()).status, 503);
  options.providerStatus = 'ACTIVE'; options.upstreamStatus = 'DISABLED'; assert.equal((await f.request()).status, 503);
  assert.equal(f.upstreamCalls.length, 1);
});

test('routing reuses catalogues populated by a previous model listing', async t => {
  const values = new Map();
  const f = await fixture(t, { policies: [{ model_pattern: '*', policy: 'ALLOW' }], assignments: [{}, {}],
    cache: { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); } },
    responses: [
      { authorization: 'Bearer upstream-test', body: catalogue },
      { authorization: 'Bearer upstream-test1', body: catalogue },
      { authorization: 'Bearer upstream-test', body: { model: 'model-a', choices: [] } },
    ],
  });
  assert.equal((await f.request()).status, 200);
  assert.equal((await f.request('/v1/chat/completions', 'POST', { model: 'model-a', messages: [] })).status, 200);
  assert.deepEqual(f.upstreamCalls.map(call => new URL(call.url).pathname), ['/v1/models', '/v1/models', '/v1/chat/completions']);
});
