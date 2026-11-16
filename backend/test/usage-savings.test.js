import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { digest } from '../src/security/credentials.js';

const enabled = process.env.TEST_DB_NAME?.startsWith('infergate_test_');
test('usage savings compare matched complete costs per filtered bucket and currency', { skip: !enabled }, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, database: process.env.TEST_DB_NAME, timezone: 'Z' });
  t.after(() => db.close());
  const credential = `adm_${randomUUID()}`;
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))', [digest(credential)]);
  const user = await db.query('INSERT INTO users(name,email) VALUES (?,?)', ['Savings report', `savings-${randomUUID()}@example.test`]);
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/admin/usage`;
  const query = new URLSearchParams({ start: '2026-10-01', end: '2026-10-02', user_id: String(user.insertId) });
  async function add(model, status, known, requested, currency = 'USD', timestamp = '2026-10-01 00:00:00.000', requestStatus = 'SUCCESS') {
    const request = await db.query('INSERT INTO api_requests(request_id,endpoint,http_method,started_at,request_status) VALUES (?,?,?,?,?)', [randomUUID(), '/v1/chat/completions', 'POST', timestamp, requestStatus]);
    const event = await db.query('INSERT INTO usage_events(api_request_id,user_id,model,request_status,timestamp) VALUES (?,?,?,?,?)', [request.insertId, user.insertId, model, requestStatus, timestamp]);
    await db.query('INSERT INTO usage_costs(usage_event_id,status,known_cost,requested_cost,currency,calculated_at) VALUES (?,?,?,?,?,?)', [event.insertId, status, known, requested, currency, timestamp]);
  }
  // Unequal requested costs ensure this is a ratio of sums, not averaged savings.
  await add('saving', 'COMPLETE', '20', '50');
  await add('saving', 'COMPLETE', '30', '150', 'USD', undefined, 'FAILED');
  await add('saving', 'COMPLETE', '1000', null);
  await add('saving', 'COMPLETE', null, '500');
  await add('saving', 'PARTIAL', '7', null);
  await add('saving', 'UNPRICED', null, null);
  await add('saving', 'UNSUPPORTED', null, null);
  await add('saving', 'COMPLETE', '10', '20', 'EUR');
  await add('saving', 'COMPLETE', '9999', '10000', 'USD', '2026-10-02 00:00:00.000');
  await add('higher-cost', 'COMPLETE', '120', '100');
  await add('free', 'COMPLETE', '0', '100');
  await add('same-cost', 'COMPLETE', '100', '100');
  await add('zero-baseline', 'COMPLETE', '10', '0');
  await add('no-comparison', 'COMPLETE', '5', null);
  await add('unpriced', 'UNPRICED', null, null);

  assert.equal((await fetch(`${url}?${query}`)).status, 401);
  const headers = { authorization: `Bearer ${credential}` };
  async function report(params) {
    const response = await fetch(`${url}?${params}`, { headers });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  }
  const data = await report(`${query}&group_by=model`);
  const cost = (bucket, currency = 'USD') => data.find(row => row.bucket === bucket).costs.find(row => row.currency === currency);
  assert.deepEqual(cost('saving'), { bucket: 'saving', currency: 'USD', estimated_cost: '1050.000000000000', known_cost: '1057.000000000000', saved_events: 2, total_reducible_cost: '200.000000000000', actual_reduced_cost: '50.000000000000', estimated_saving_percent: 0.75 });
  assert.equal(cost('saving', 'EUR').total_reducible_cost, '20.000000000000');
  assert.equal(cost('saving', 'EUR').actual_reduced_cost, '10.000000000000');
  assert.equal(cost('free').actual_reduced_cost, '0.000000000000');
  assert.equal(cost('zero-baseline').total_reducible_cost, '0.000000000000');
  assert.equal(cost('zero-baseline').actual_reduced_cost, '10.000000000000');
  for (const bucket of ['no-comparison', 'unpriced']) {
    assert.equal(cost(bucket).total_reducible_cost, null);
    assert.equal(cost(bucket).actual_reduced_cost, null);
  }
  for (const bucket of ['higher-cost', 'free', 'same-cost', 'zero-baseline']) assert.equal(cost(bucket).saved_events, 1);
  for (const bucket of ['no-comparison', 'unpriced']) assert.equal(cost(bucket).saved_events, 0);
  assert.equal(cost('saving', 'EUR').saved_events, 1);
  assert.equal(cost('saving', 'EUR').estimated_saving_percent, 0.5);
  assert.equal(cost('higher-cost').estimated_saving_percent, -0.2);
  assert.equal(cost('free').estimated_saving_percent, 1);
  assert.equal(cost('same-cost').estimated_saving_percent, 0);
  for (const bucket of ['zero-baseline', 'no-comparison', 'unpriced']) assert.equal(cost(bucket).estimated_saving_percent, null);

  const company = await report(`${query}&model=saving`);
  assert.equal(company[0].costs.find(row => row.currency === 'USD').saved_events, 2);
  assert.equal(company[0].costs.find(row => row.currency === 'USD').estimated_saving_percent, 0.75);
  const successful = await report(`${query}&model=saving&request_status=SUCCESS`);
  assert.equal(successful[0].costs.find(row => row.currency === 'USD').total_reducible_cost, '50.000000000000');
  assert.equal(successful[0].costs.find(row => row.currency === 'USD').actual_reduced_cost, '20.000000000000');
  assert.equal(successful[0].costs.find(row => row.currency === 'USD').saved_events, 1);
  assert.equal(successful[0].costs.find(row => row.currency === 'USD').estimated_saving_percent, 0.6);
  assert.deepEqual(await report(`${query}&model=missing`), []);
});
