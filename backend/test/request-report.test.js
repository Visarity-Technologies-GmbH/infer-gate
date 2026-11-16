import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('recent requests include user names without excluding unattributed requests or changing pagination', async t => {
  const queries = [];
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: 200 - index,
    user_id: index === 0 ? null : 7,
    user_name: index === 0 ? null : 'Test user',
  }));
  const db = { query: async (sql, params) => {
    if (sql.includes('FROM admin_sessions')) return [{ token_hash: 'test-session' }];
    queries.push({ sql, params });
    return rows;
  } };
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/admin/requests`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(queries.length, 0);
  const response = await fetch(`${url}?before=201&start=2026-10-01&end=2026-10-02`, {
    headers: { Authorization: 'Bearer adm_test' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: rows, next_before: 101 });
  assert.match(queries[0].sql, /u.name AS user_name/);
  assert.match(queries[0].sql, /LEFT JOIN users u ON u.id=r.user_id/);
  assert.match(queries[0].sql, /latest.api_request_id=r.id ORDER BY latest.id DESC LIMIT 1/);
  assert.match(queries[0].sql, /AND r.id<\? ORDER BY r.id DESC LIMIT 100/);
  assert.deepEqual(queries[0].params, [new Date('2026-10-01'), new Date('2026-10-02'), '201']);
});
