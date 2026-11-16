import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('user options match any selected group, preserve pagination, and reject invalid groups', async t => {
  const queries = [];
  const rows = Array.from({ length: 500 }, (_, index) => ({ id: index + 501, name: `User ${index}` }));
  const db = { query: async (sql, params) => {
    if (sql.includes('FROM admin_sessions')) return [{ token_hash: 'test-session' }];
    queries.push({ sql, params });
    return rows;
  } };
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/admin/users`;
  const headers = { Authorization: 'Bearer adm_test' };
  assert.equal((await fetch(`${url}?group_id=7`)).status, 401);
  assert.equal(queries.length, 0);
  const response = await fetch(`${url}?group_id=7&group_id=9&group_id=7&after=500`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: rows, next_after: 1000 });
  assert.match(queries[0].sql, /EXISTS \(SELECT 1 FROM user_groups g WHERE g.user_id=users.id AND g.group_id IN \(\?,\?\)\)/);
  assert.match(queries[0].sql, /WHERE id>\?.*ORDER BY id LIMIT 500/);
  assert.deepEqual(queries[0].params, ['500', '7', '9']);
  assert.doesNotMatch(queries[0].sql, /JOIN/);
  await fetch(url, { headers });
  assert.doesNotMatch(queries[1].sql, /user_groups/);
  assert.deepEqual(queries[1].params, ['0']);
  queries.length = 0;
  for (const query of ['group_id=', 'group_id=0', 'group_id=1%20OR%201=1', 'group_id=7&group_id=bad', Array(501).fill('group_id=7').join('&')]) {
    assert.equal((await fetch(`${url}?${query}`, { headers })).status, 400);
  }
  assert.equal(queries.length, 0);
});
