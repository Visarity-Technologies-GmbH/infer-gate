import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('model options require admin access and list distinct nonempty model IDs from usage events', async t => {
  let queries = 0;
  let models = [{ model: 'model-a' }, { model: 'provider/model-b' }];
  const db = { query: async sql => {
    if (sql.includes('FROM admin_sessions')) return [{ token_hash: 'test-session' }];
    queries++;
    assert.equal(sql, "SELECT DISTINCT model FROM usage_events WHERE model IS NOT NULL AND model<>'' ORDER BY model");
    return models;
  } };
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/admin/usage/models`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(queries, 0);
  const headers = { Authorization: 'Bearer adm_test' };
  // Options are independent of the selected model/date/status filters so the
  // administrator can switch models even when the current report is empty.
  const response = await fetch(`${url}?model=missing&start=2026-01-01&request_status=FAILED`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: ['model-a', 'provider/model-b'] });
  models = [];
  assert.deepEqual(await (await fetch(url, { headers })).json(), { data: [] });
});
