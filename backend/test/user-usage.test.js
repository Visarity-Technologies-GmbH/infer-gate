import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { digest, token } from '../src/security/credentials.js';
import { userUsage, remainingAllowance } from '../src/services/user-usage.js';
import { database } from '../src/db/pool.js';

async function serve(t, db) {
  const server = createApp(db, {}, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('remaining allowance uses exact decimals and clamps exhausted caps to zero', () => {
  assert.equal(remainingAllowance({ enabled: false }), null);
  assert.equal(remainingAllowance({ enabled: true, basis: 'TOKENS', cutoff: '4.75000000', consumed: '0.000001' }), '4.74999900');
  assert.equal(remainingAllowance({ enabled: true, basis: 'COST', cutoff: '19.000000000000', consumed: '18.999999999999' }), '0.000000000001');
  assert.equal(remainingAllowance({ enabled: true, basis: 'COST', cutoff: '19.000000000000', consumed: '20.000000000000' }), '0.000000000000');
});

test('today uses a half-open UTC interval and weekly caps retain their full period', async () => {
  const now = new Date('2026-10-18T23:59:59.999Z');
  const db = { async query(sql, params) {
    if (sql.includes('GROUP BY bucket')) return [];
    if (sql.includes('GROUP BY c.currency')) {
      assert.deepEqual(params, ['7', new Date('2026-10-18T00:00:00Z'), new Date('2026-10-19T00:00:00Z')]);
      return [{ currency: 'USD', estimated_cost: null, known_cost: null }];
    }
    if (sql.includes('SUM(input_tokens)')) {
      assert.deepEqual(params, ['7', new Date('2026-10-18T00:00:00Z'), new Date('2026-10-19T00:00:00Z')]);
      return [{ usage_events: 1, input_tokens: null, output_tokens: '0', total_tokens: null }];
    }
    if (sql.includes('FROM user_usage_limits')) return [{ enabled: 1, period: 'WEEKLY', basis: 'TOKENS', token_limit: '1000000' }];
    assert.equal(params[0], '7');
    assert.equal(params[1].toISOString(), '2026-10-12T00:00:00.000Z');
    return [{ consumed: '900000' }];
  } };
  const result = await userUsage(db, '7', now);
  assert.equal(result.today.input_tokens, null);
  assert.equal(result.today.output_tokens, '0');
  assert.equal(result.cap.remaining, '0.05000000');
  assert.equal(result.cap.resets_at, '2026-10-19T00:00:00.000Z');
});

test('user costs preserve exact amounts, currencies, unknown assessments and UTC user scope', async () => {
  const costs = [
    { currency: 'EUR', estimated_cost: null, known_cost: null },
    { currency: 'USD', estimated_cost: '0.123456789012', known_cost: '0.123456789013' }
  ];
  const now = new Date('2026-10-18T10:00:00Z');
  const db = { async query(sql, params) {
    if (sql.includes('FROM user_usage_limits')) return [];
    if (sql.includes('GROUP BY bucket')) return [];
    assert.deepEqual(params, ['8', new Date('2026-10-18T00:00:00Z'), new Date('2026-10-19T00:00:00Z')]);
    assert.match(sql, /WHERE e.user_id=\? AND e.timestamp>=\? AND e.timestamp<\?/);
    assert.doesNotMatch(sql, /request_status=/); // Reported failed usage stays visible.
    if (sql.includes('GROUP BY c.currency')) return costs;
    return [{ usage_events: 4, priced_events: 1, partial_events: 1, unpriced_events: 1, unsupported_events: 1 }];
  } };
  const result = await userUsage(db, '8', now);
  assert.deepEqual(result.today.costs, costs);
  assert.equal(result.today.priced_events, 1);
  assert.equal(result.today.partial_events, 1);
  assert.equal(result.today.unpriced_events, 1);
  assert.equal(result.today.unsupported_events, 1);
});

test('token activity covers 14 UTC dates across year boundaries and preserves unknown totals', async () => {
  const db = { async query(sql, params) {
    if (sql.includes('GROUP BY bucket')) {
      assert.deepEqual(params, ['7', new Date('2026-12-21T00:00:00Z'), new Date('2027-01-04T00:00:00Z')]);
      assert.match(sql, /WHERE user_id=\? AND timestamp>=\? AND timestamp<\?/);
      assert.doesNotMatch(sql, /request_status=/);
      return [
        { bucket: '2026-12-21', usage_events: 1, total_tokens: '12', total_tokens_reported_events: 1 },
        { bucket: '2027-01-02', usage_events: 1, total_tokens: null, total_tokens_reported_events: 0 },
        { bucket: '2027-01-03', usage_events: 2, total_tokens: '3', total_tokens_reported_events: 1 }
      ];
    }
    if (sql.includes('SUM(input_tokens)')) return [{ usage_events: 2 }];
    return [];
  } };
  const result = await userUsage(db, '7', new Date('2027-01-03T23:59:59.999Z'));
  assert.equal(result.activity.start, '2026-12-21T00:00:00.000Z');
  assert.equal(result.activity.end, '2027-01-04T00:00:00.000Z');
  assert.equal(result.activity.days.length, 14);
  assert.equal(result.activity.days[0].total_tokens, '12');
  assert.deepEqual(result.activity.days[1], { bucket: '2026-12-22', usage_events: 0, total_tokens: '0', total_tokens_reported_events: 0 });
  assert.equal(result.activity.days[12].total_tokens, null);
  assert.equal(result.activity.days[13].total_tokens, '3');
  assert.equal(result.activity.days[13].total_tokens_reported_events, 1);
});

test('viewing keys are user-scoped, rotate atomically and cannot authorize administration', async t => {
  const admin = token('adm_'), keys = new Map(), active = new Map([['1', true], ['2', true]]);
  const db = { async query(sql, params = []) {
    if (sql.includes('GROUP BY bucket')) return [{ bucket: params[1].toISOString().slice(0, 10), total_tokens: params[0] === '1' ? '12' : '99' }];
    if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
    if (sql.startsWith('UPDATE api_requests')) return { affectedRows: 1 };
    if (sql.includes('FROM admin_sessions')) return params[0] === digest(admin) ? [{ token_hash: params[0] }] : [];
    if (sql.startsWith('SELECT id FROM users')) return active.has(params[0]) ? [{ id: params[0] }] : [];
    if (sql.startsWith('INSERT INTO user_viewing_keys')) { keys.set(params[0], params[1]); return { affectedRows: 1 }; }
    if (sql.startsWith('SELECT created_at')) return keys.has(params[0]) ? [{ created_at: '2026-10-18' }] : [];
    if (sql.includes('JOIN users u')) return [...keys].filter(([id, hash]) => hash === params[0] && active.get(id)).map(([id]) => ({ id, name: `Viewer ${id}`, email: `viewer${id}@example.test` }));
    if (sql.includes('GROUP BY c.currency')) return [{ currency: 'USD', estimated_cost: params[0] === '1' ? '0.123456789012' : '99.000000000000', known_cost: params[0] === '1' ? '0.123456789012' : '99.000000000000' }];
    if (sql.includes('FROM user_usage_limits')) return [];
    if (sql.includes('SUM(input_tokens)')) return [{ usage_events: 1, total_tokens: params[0] === '1' ? '12' : '99' }];
    throw new Error(`Unexpected SQL: ${sql}`);
  }, transaction(fn) { return fn(db); } };
  const base = await serve(t, db);
  const rotate = async (id, credential = admin) => {
    const response = await fetch(`${base}/admin/users/${id}/viewing-key`, { method: 'POST', headers: { authorization: `Bearer ${credential}` } });
    return { status: response.status, body: await response.json() };
  };
  const usage = (key, suffix = '', options = {}) => fetch(`${base}/user/usage${suffix}`, { headers: { authorization: `Bearer ${key}` }, ...options });
  const first = await rotate('1'), second = await rotate('2');
  assert.equal(first.status, 201);
  assert.match(first.body.key, /^uvk_[\w-]{43}$/);
  assert.equal(keys.get('1'), digest(first.body.key));
  const own = await (await usage(first.body.key)).json();
  assert.deepEqual(own.user, { name: 'Viewer 1', email: 'viewer1@example.test' });
  assert.equal(own.activity.days.length, 14);
  assert.equal(own.activity.days[0].total_tokens, '12');
  assert.equal(own.today.total_tokens, '12');
  assert.equal(own.today.costs[0].estimated_cost, '0.123456789012');
  const other = await (await usage(second.body.key)).json();
  assert.deepEqual(other.user, { name: 'Viewer 2', email: 'viewer2@example.test' });
  assert.equal(other.activity.days[0].total_tokens, '99');
  assert.equal(other.today.total_tokens, '99');
  assert.equal(other.today.costs[0].estimated_cost, '99.000000000000');
  assert.equal((await usage(first.body.key, '?user_id=2')).status, 400);
  const status = await fetch(`${base}/admin/users/1/viewing-key`, { headers: { authorization: `Bearer ${admin}` } });
  assert.deepEqual(await status.json(), { exists: true, created_at: '2026-10-18' });
  assert.equal((await rotate('2', first.body.key)).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${first.body.key}` } })).status, 401);
  for (const path of ['/admin/users', '/admin/usage', '/admin/users/1/usage-limit'])
    assert.equal((await fetch(base + path, { headers: { authorization: `Bearer ${first.body.key}` } })).status, 401);
  assert.equal((await rotate('999')).status, 404);
  const replacement = await rotate('1');
  assert.equal((await usage(first.body.key)).status, 401);
  const response = await usage(replacement.body.key);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  active.set('1', false);
  assert.equal((await usage(replacement.body.key)).status, 401);
  for (const key of ['', admin, token('pak_'), token('uvk_')]) assert.equal((await usage(key)).status, 401);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await usage(second.body.key, '', { method })).status, 404);
});

test('real MySQL viewing keys rotate with one row per user and usage excludes other users and days', { skip: !process.env.TEST_DB_NAME?.startsWith('infergate_test_') }, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, database: process.env.TEST_DB_NAME, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
  t.after(() => db.close());
  const suffix = randomUUID();
  const ids = [];
  for (let i = 0; i < 2; i++) ids.push((await db.query('INSERT INTO users(name,email) VALUES (?,?)', ['Viewer', `${suffix}-${i}@viewer.test`])).insertId);
  const admin = token('adm_');
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))', [digest(admin)]);
  const base = await serve(t, db);
  const rotate = async () => {
    const response = await fetch(`${base}/admin/users/${ids[0]}/viewing-key`, { method: 'POST', headers: { authorization: `Bearer ${admin}` } });
    assert.equal(response.status, 201); return (await response.json()).key;
  };
  const first = await rotate();
  const rotated = await Promise.all([rotate(), rotate()]);
  const read = key => fetch(`${base}/user/usage`, { headers: { authorization: `Bearer ${key}` } });
  assert.equal((await read(first)).status, 401);
  const outcomes = await Promise.all(rotated.map(read));
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 401]);
  assert.equal((await db.query('SELECT * FROM user_viewing_keys WHERE user_id=?', [ids[0]])).length, 1);
  const now = new Date('2026-10-18T12:00:00Z');
  let eventIndex = 0;
  for (const [userId, timestamp, total, status] of [
    [ids[0], '2026-10-18T00:00:00Z', 12, 'SUCCESS'],
    [ids[0], '2026-10-18T10:00:00Z', 3, 'FAILED'],
    [ids[0], '2026-10-17T23:59:59.999Z', 100, 'SUCCESS'],
    [ids[0], '2026-10-19T00:00:00Z', 200, 'SUCCESS'],
    [ids[1], '2026-10-18T01:00:00Z', 999, 'SUCCESS'],
    [ids[0], '2026-10-18T11:00:00Z', null, 'SUCCESS'],
    [ids[0], '2026-10-18T11:30:00Z', null, 'SUCCESS'],
    [ids[0], '2026-10-05T00:00:00Z', 7, 'SUCCESS'],
    [ids[0], '2026-10-04T23:59:59.999Z', 900, 'SUCCESS']
  ]) {
    const time = new Date(timestamp);
    const request = await db.query("INSERT INTO api_requests(request_id,user_id,endpoint,http_method,started_at,completed_at,request_status) VALUES (?,?,'/v1/chat/completions','POST',?,?,?)", [randomUUID(), userId, time, time, status]);
    const event = await db.query("INSERT INTO usage_events(api_request_id,user_id,total_tokens,request_status,timestamp) VALUES (?,?,?,?,?)", [request.insertId, userId, total, status, time]);
    if (eventIndex !== 5) {
      const costStatus = eventIndex === 1 ? 'PARTIAL' : eventIndex === 6 ? 'UNSUPPORTED' : 'COMPLETE';
      const value = eventIndex === 0 ? '0.123456789012' : eventIndex === 1 ? '0.000000000001' : eventIndex === 6 ? null : '99.000000000000';
      await db.query('INSERT INTO usage_costs(usage_event_id,status,currency,known_cost,calculated_at) VALUES (?,?,?,?,?)',
        [event.insertId, costStatus, eventIndex === 6 ? 'EUR' : 'USD', value, time]);
    }
    eventIndex++;
  }
  await db.query("INSERT INTO user_usage_limits(user_id,enabled,period,basis,token_limit) VALUES (?,TRUE,'WEEKLY','TOKENS',1000)", [ids[0]]);
  const result = await userUsage(db, ids[0], now);
  assert.equal(result.activity.days.length, 14);
  assert.equal(result.activity.days[0].bucket, '2026-10-05');
  assert.equal(result.activity.days[0].total_tokens, '7');
  assert.equal(result.activity.days[1].total_tokens, '0');
  assert.equal(result.activity.days[12].total_tokens, '100');
  assert.equal(result.activity.days[13].total_tokens, '15');
  assert.equal(result.today.total_tokens, '15');
  assert.equal(result.today.input_tokens, null);
  assert.equal(String(result.today.priced_events), '1');
  assert.equal(String(result.today.partial_events), '1');
  assert.equal(String(result.today.unpriced_events), '1');
  assert.equal(String(result.today.unsupported_events), '1');
  assert.deepEqual(result.today.costs, [
    { currency: 'EUR', estimated_cost: null, known_cost: null },
    { currency: 'USD', estimated_cost: '0.123456789012', known_cost: '0.123456789013' }
  ]);
  assert.equal(result.cap.consumed, '0.000112');
  assert.equal(result.cap.remaining, '0.00083800');
  const currentKey = rotated[outcomes.findIndex(r => r.status === 200)];
  await db.query("UPDATE users SET status='SUSPENDED' WHERE id=?", [ids[0]]);
  assert.equal((await read(currentKey)).status, 401);
});
