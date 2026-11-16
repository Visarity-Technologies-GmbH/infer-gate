import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function fixture(t, data) {
  const queries = [];
  const db = { query: async (sql, params) => {
    if (sql.includes('FROM admin_sessions')) return [{ token_hash: 'test-session' }];
    queries.push({ sql, params });
    return data;
  } };
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { queries, url: `http://127.0.0.1:${server.address().port}/admin/usage/categories` };
}

test('category report requires administrator authentication before querying usage', async t => {
  const { url, queries } = await fixture(t, []);
  assert.equal((await fetch(url)).status, 401);
  assert.equal(queries.length, 0);
});

test('category report counts all usage events within the filtered half-open interval, retaining null categories', async t => {
  const data = [
    { bucket: null, usage_events: 4, easy_events: 1, medium_events: 1, hard_events: 1, unknown_complexity_events: 1 },
    { bucket: 'coding', usage_events: 2, easy_events: 0, medium_events: 1, hard_events: 1, unknown_complexity_events: 0 },
  ];
  const { url, queries } = await fixture(t, data);
  const response = await fetch(`${url}?start=2026-10-01T00:00:00Z&end=2026-10-02T00:00:00Z&group_id=7`, {
    headers: { Authorization: 'Bearer adm_test' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /SELECT e.category AS bucket,COUNT\(\*\) AS usage_events/);
  assert.match(queries[0].sql, /e.timestamp>=\? AND e.timestamp<\?/);
  assert.match(queries[0].sql, /GROUP BY bucket/);
  for (const [level, field] of [[0, 'easy_events'], [1, 'medium_events'], [2, 'hard_events']]) {
    assert(queries[0].sql.includes(`COUNT(CASE WHEN e.complexity=${level} THEN 1 END) AS ${field}`));
  }
  assert(queries[0].sql.includes('COUNT(CASE WHEN e.complexity IS NULL THEN 1 END) AS unknown_complexity_events'));
  assert.doesNotMatch(queries[0].sql, /LIMIT|JOIN|COALESCE/);
  assert.deepEqual(queries[0].params, [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z'), '7']);
});

test('category chart supports the usage grouping options through an SQL allowlist', async t => {
  const { url, queries } = await fixture(t, [{ bucket: 'example', usage_events: 2 }]);
  const headers = { Authorization: 'Bearer adm_test' };
  for (const [group, expression] of [
    ['category', 'e.category'], ['model', 'e.model'], ['user', 'e.user_id'],
    ['proxy_key', 'e.proxy_api_key_id'], ['upstream_key', 'e.upstream_api_key_id'],
    ['provider', 'e.provider_id'], ['day', 'DATE(e.timestamp)'],
    ['week', 'YEARWEEK(e.timestamp,3)'], ['month', "DATE_FORMAT(e.timestamp,'%Y-%m')"],
  ]) {
    assert.equal((await fetch(`${url}?group_by=${group}`, { headers })).status, 200);
    assert(queries.at(-1).sql.includes(`SELECT ${expression} AS bucket,COUNT(*) AS usage_events`));
  }
  queries.length = 0;
  for (const path of ['/usage/categories', '/usage']) {
    for (const group of ['invalid', 'constructor', '__proto__', 'e.category;DROP TABLE usage_events', '']) {
      const response = await fetch(`${url.replace('/usage/categories', path)}?group_by=${encodeURIComponent(group)}`, { headers });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid_group');
    }
  }
  assert.equal(queries.length, 0);
});

test('category report returns an empty dataset and rejects invalid intervals before querying', async t => {
  const { url, queries } = await fixture(t, []);
  const headers = { Authorization: 'Bearer adm_test' };
  assert.deepEqual(await (await fetch(url, { headers })).json(), { data: [] });
  queries.length = 0;
  assert.equal((await fetch(`${url}?start=invalid`, { headers })).status, 400);
  assert.equal(queries.length, 0);
});
