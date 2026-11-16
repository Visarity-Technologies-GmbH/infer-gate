import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { periodBounds, validateUsageLimit, usageLimitStatus, enforceUsageLimit } from '../src/services/usage-limits.js';
import { createApp } from '../src/app.js';
import { database } from '../src/db/pool.js';
import { digest, encrypt } from '../src/security/credentials.js';

test('usage limits validate exact decimals and convert millions to integer tokens', () => {
  const settings = { enabled: true, period: 'DAILY', basis: 'TOKENS', amount: '5' };
  assert.equal(validateUsageLimit(settings).token_limit, '5000000');
  assert.equal(validateUsageLimit({ ...settings, amount: '0.000001' }).token_limit, '1');
  assert.equal(validateUsageLimit({ ...settings, basis: 'COST', amount: '19.123456789012' }).cost_limit, '19.123456789012');
  for (const patch of [{ amount: '0' }, { amount: '-1' }, { amount: '1e2' }, { amount: 5 }, { amount: '0.0000001' },
    { amount: '18446744073710' }, { enabled: 'true' }, { period: 'MONTHLY' }, { basis: 'PRICE' }, { currency: 'USD' }]) {
    assert.throws(() => validateUsageLimit({ ...settings, ...patch }), { status: 400 });
  }
});

test('calendar periods reset at UTC midnight and Monday, including year boundaries', () => {
  for (const [period, date, start, end] of [
    ['DAILY', '2026-10-17T23:59:59.999Z', '2026-10-17T00:00:00.000Z', '2026-10-18T00:00:00.000Z'],
    ['DAILY', '2026-10-18T00:00:00Z', '2026-10-18T00:00:00.000Z', '2026-10-19T00:00:00.000Z'],
    ['WEEKLY', '2027-01-03T23:59:59Z', '2026-12-28T00:00:00.000Z', '2027-01-04T00:00:00.000Z'],
    ['WEEKLY', '2027-01-04T00:00:00Z', '2027-01-04T00:00:00.000Z', '2027-01-11T00:00:00.000Z']
  ]) {
    const bounds = periodBounds(period, new Date(date));
    assert.equal(bounds.start.toISOString(), start); assert.equal(bounds.end.toISOString(), end);
  }
});

function statusDb({ basis = 'TOKENS', consumed = '0', enabled = true, absent = false } = {}) {
  return { async query(sql) {
    if (sql.includes('FROM user_usage_limits')) return absent ? [] : [{ enabled, period: 'DAILY', basis, token_limit: '5000000', cost_limit: '20.000000000000' }];
    if (sql.includes('FROM usage_events e LEFT')) return [{ consumed }];
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
}
test('95 percent cutoff uses exact integers for tokens and USD; disabled users stay unlimited', async () => {
  for (const [basis, below, at] of [['TOKENS', '4749999', '4750000'], ['COST', '18.999999999999', '19.000000000000']]) {
    assert.equal((await usageLimitStatus(statusDb({ basis, consumed: below }), 1)).blocked, false);
    const status = await usageLimitStatus(statusDb({ basis, consumed: at }), 1);
    assert.equal(status.blocked, true); assert.equal(status.block_reason, 'user_usage_limit_reached');
    assert.equal(status.cutoff, basis === 'TOKENS' ? '4.75000000' : '19.000000000000');
  }
  for (const settings of [{ enabled: false }, { absent: true }]) assert.equal((await usageLimitStatus(statusDb(settings), 1)).enabled, false);
});
test('zero counted usage does not block and the 95 percent cutoff retains its retry time', async () => {
  const now = new Date('2026-10-17T23:59:00Z');
  for (const basis of ['TOKENS', 'COST']) {
    const status = await usageLimitStatus(statusDb({ basis }), 1, { now });
    assert.equal(status.blocked, false); assert.equal(status.block_reason, null);
    await enforceUsageLimit(statusDb({ basis }), 1, { now });
  }
  await assert.rejects(enforceUsageLimit(statusDb({ consumed: '4750000' }), 1, { now }), error => {
    assert.equal(error.status, 429); assert.equal(error.code, 'user_usage_limit_reached');
    assert.equal(error.type, 'usage_limit_error'); assert.equal(error.retryAfter, 60); return true;
  });
});

test('caps reject before classification/routing, preserve tracking and require administrator authentication', async t => {
  const records = [], config = { timeout: 1000, bodyLimit: 10000 };
  let upstreamCalls = 0;
  const db = {
    async query(sql, params) {
      if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
      if (sql.includes('FROM proxy_api_keys k')) return [{ id: 2, user_id: 1, status: 'ACTIVE', user_status: 'ACTIVE', classification_handler_id: 3 }];
      if (sql.includes('FROM user_usage_limits') || sql.includes('FROM usage_events e LEFT'))
        return statusDb({ consumed: '4750000' }).query(sql, params);
      if (sql.includes('completed_at=')) records.push(params);
      if (sql.startsWith('UPDATE api_requests SET usage_expected=')) return { affectedRows: 1 };
      else if (sql.startsWith('UPDATE api_requests SET user_id=')) return { affectedRows: 1 };
      throw new Error(`Unexpected database access: ${sql}`);
    },
    transaction(fn) { return fn(db); }
  };
  const server = createApp(db, config, { log() {}, fetchImpl() { upstreamCalls++; throw new Error('Must not be called'); } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer pak_test', 'content-type': 'application/json' }, body: '{"model":"test"}' });
  assert.equal(response.status, 429); assert(Number(response.headers.get('retry-after')) > 0);
  assert(response.headers.get('x-infergate-request-id'));
  assert.equal((await response.json()).error.code, 'user_usage_limit_reached');
  assert.equal(upstreamCalls, 0); assert.equal(records[0][10], 'REJECTED'); assert.equal(records[0][12], 'usage_limit_error');
  for (const method of ['GET', 'PUT']) assert.equal((await fetch(`${base}/admin/users/1/usage-limit`, { method })).status, 401);
});

test('failed accounting commits preserve failure metadata', async t => {
  let marked = false, expected = false;
  const encryptionKey = randomBytes(32);
  const db = {
    async query(sql) {
      if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
      if (sql.includes('FROM proxy_api_keys k')) return [{ id: 1, user_id: 2, role_id: 3, role_status: 'ACTIVE', status: 'ACTIVE', user_status: 'ACTIVE' }];
      if (sql.includes('FROM user_usage_limits') || sql.includes('FROM model_policy_rules')) return [];
      if (sql.includes('FROM role_upstream_assignments')) return [{ upstream_api_key_id: 4, provider_id: 5, key_status: 'ACTIVE', provider_status: 'ACTIVE', api_type: 'OPENAI_COMPATIBLE', api_url: 'https://test.example/v1', encrypted_api_key: encrypt('test-key', encryptionKey) }];
      if (sql.includes('usage_expected=TRUE')) expected = true;
      if (sql.includes("error_code='accounting_write_failed'")) marked = true;
      return { affectedRows: 1 };
    },
    transaction() { throw new Error('Simulated accounting rollback'); }
  };
  const server = createApp(db, { encryptionKey, timeout: 1000, bodyLimit: 10000, modelDefault: 'ALLOW' }, { log() {}, fetchImpl: async () => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer pak_test', 'content-type': 'application/json' }, body: '{"model":"test"}' });
    await response.text();
  });
  assert(expected); assert(marked);
});

test('real MySQL cap aggregation, admin changes, missing prices, unknown usage and period rollover', { skip: !process.env.TEST_DB_NAME?.startsWith('infergate_test_') }, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, database: process.env.TEST_DB_NAME, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
  t.after(() => db.close());
  const suffix = randomUUID(), encryptionKey = randomBytes(32);
  const user = (await db.query('INSERT INTO users(name,email) VALUES (?,?)', ['Cap user', `${suffix}@caps.test`])).insertId;
  const otherUser = (await db.query('INSERT INTO users(name,email) VALUES (?,?)', ['Other user', `${suffix}@other.test`])).insertId;
  const provider = (await db.query('INSERT INTO llm_inference_providers(name,api_url) VALUES (?,?)', [suffix, 'https://caps.example/v1'])).insertId;
  const upstream = (await db.query('INSERT INTO upstream_api_keys(provider_id,name,encrypted_api_key,key_fingerprint) VALUES (?,?,?,?)', [provider, 'Cap upstream', encrypt('cap-upstream', encryptionKey), digest(suffix).slice(0, 16)])).insertId;
  const policy = (await db.query('INSERT INTO model_policies(name) VALUES (?)', [suffix])).insertId;
  const role = (await db.query('INSERT INTO roles(name,model_policy_id) VALUES (?,?)', [suffix, policy])).insertId;
  await db.query('INSERT INTO role_upstream_assignments(role_id,upstream_api_key_id) VALUES (?,?)', [role, upstream]);
  const credentials = [`pak_${randomBytes(12).toString('hex')}`, `pak_${randomBytes(12).toString('hex')}`];
  const keys = [];
  for (const credential of credentials) keys.push((await db.query('INSERT INTO proxy_api_keys(user_id,name,key_hash,key_prefix,role_id) VALUES (?,?,?,?,?)', [user, 'Cap key', digest(credential), credential.slice(0, 12), role])).insertId);
  const session = `adm_${randomBytes(12).toString('hex')}`;
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))', [digest(session)]);
  let calls = 0, mode = 'normal';
  const server = createApp(db, { encryptionKey, timeout: 1000, bodyLimit: 10000, modelDefault: 'ALLOW' }, { log() {}, fetchImpl: async () => {
    calls++;
    if (mode === 'missing') return Response.json({ id: 'no-usage' });
    if (mode === 'error') return Response.json({ error: { message: 'Rate limited' } }, { status: 429 });
    return Response.json({ model: 'unpriced-model', usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
  } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function setLimit(basis, amount, enabled = true, period = 'DAILY') {
    const response = await fetch(`${base}/admin/users/${user}/usage-limit`, { method: 'PUT', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: JSON.stringify({ enabled, period, basis, amount }) });
    assert.equal(response.status, 204, await response.text());
  }
  const request = async (index = 0) => {
    const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${credentials[index]}`, 'content-type': 'application/json' }, body: '{"model":"unpriced-model"}' });
    return { status: response.status, body: await response.json() };
  };
  await setLimit('TOKENS', '0.00002'); // 20 tokens, cutoff 19.
  assert.equal((await request()).status, 200);
  assert.equal((await request(1)).status, 200);
  assert.equal((await request()).status, 429); assert.equal(calls, 2);
  assert.equal((await usageLimitStatus(db, user)).consumed, '0.000024');
  assert.equal((await usageLimitStatus(db, otherUser)).enabled, false);
  await setLimit('TOKENS', '1'); assert.equal((await request()).status, 200);
  await setLimit('COST', '20'); assert.equal((await request()).status, 200);
  assert.equal((await usageLimitStatus(db, user)).consumed, '0.000000000000'); // Missing prices count as zero.
  await db.query(`INSERT INTO model_pricing(provider_id,model_pattern,input_price_per_million,output_price_per_million,currency) VALUES (?,'unpriced-model',1000000,4500000,'USD')`, [provider]);
  assert.equal((await request()).status, 200); // 10 input + 9 output = USD 19.
  assert.equal((await request()).body.error.code, 'user_usage_limit_reached');
  await setLimit('COST', '100'); mode = 'error'; assert.equal((await request()).status, 429);
  assert.equal((await usageLimitStatus(db, user)).blocked, false); // Upstream errors do not block later requests.
  mode = 'missing'; assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 200); // Missing usage contributes zero.
  await setLimit('TOKENS', '1', false); assert.equal((await request()).status, 200);
  await setLimit('TOKENS', '1'); assert.equal((await request()).status, 200);
  const tomorrow = periodBounds('DAILY').end;
  assert.equal((await usageLimitStatus(db, user, { now: tomorrow })).blocked, false);
  await setLimit('TOKENS', '1', true, 'WEEKLY');
  assert.equal((await usageLimitStatus(db, user)).consumed, '0.000060');
  // Test SQL handling of incomplete usage and individual missing prices independently.
  await db.query("INSERT INTO user_usage_limits(user_id,enabled,period,basis,cost_limit) VALUES (?,TRUE,'DAILY','COST',100)", [otherUser]);
  const addEvent = async (usage, cost, timestamp = new Date(), requestStatus = 'SUCCESS') => {
    const request = await db.query("INSERT INTO api_requests(request_id,user_id,endpoint,http_method,started_at,completed_at,request_status,usage_expected) VALUES (?,?,'/v1/chat/completions','POST',?,?,?,TRUE)", [randomUUID(), otherUser, timestamp, timestamp, requestStatus]);
    const event = await db.query("INSERT INTO usage_events(api_request_id,user_id,input_tokens,output_tokens,total_tokens,request_status,timestamp) VALUES (?,?,?,?,?,?,?)", [request.insertId, otherUser, usage.input, usage.output, usage.total, requestStatus, timestamp]);
    await db.query('INSERT INTO usage_costs(usage_event_id,status,input_cost,output_cost,cache_write_cost,known_cost,currency,calculated_at) VALUES (?,?,?,?,?,?,\'USD\',?)', [event.insertId, cost.status, cost.input ?? null, cost.output ?? null, '0', cost.known ?? null, timestamp]);
  };
  await addEvent({ input: 10, output: 2, total: 12 }, { status: 'PARTIAL', input: '10', known: '10' });
  let otherStatus = await usageLimitStatus(db, otherUser);
  assert.equal(otherStatus.blocked, false); assert.equal(otherStatus.consumed, '10.000000000000'); // Missing output price is zero.
  const priorDay = new Date(periodBounds('DAILY').start.getTime() - 1);
  await addEvent({ input: 1000, output: 1000, total: 2000 }, { status: 'COMPLETE', known: '2000' }, priorDay);
  assert.equal((await usageLimitStatus(db, otherUser)).consumed, '10.000000000000'); // Half-open period.
  await addEvent({ input: 1, output: null, total: null }, { status: 'PARTIAL', known: '1' });
  assert.equal((await usageLimitStatus(db, otherUser)).blocked, false);
  await db.query("UPDATE user_usage_limits SET basis='TOKENS',token_limit=1000000,cost_limit=NULL WHERE user_id=?", [otherUser]);
  assert.equal((await usageLimitStatus(db, otherUser)).blocked, false);
  assert.equal((await usageLimitStatus(db, otherUser)).consumed, '0.000012');
  // Failed usage stays excluded; cancelled usage with a known total reaches the cutoff.
  for (const status of ['FAILED', 'CANCELLED']) await addEvent({ input: 1000000, output: 1000000, total: 2000000 }, { status: 'COMPLETE', known: '1000' }, new Date(), status);
  assert.equal((await usageLimitStatus(db, otherUser)).consumed, '2.000012');
  await assert.rejects(enforceUsageLimit(db, otherUser), error => error.code === 'user_usage_limit_reached');
  await addEvent({ input: 1, output: null, total: null }, { status: 'PARTIAL', known: '500' }, new Date(), 'CANCELLED');
  assert.equal((await usageLimitStatus(db, otherUser)).consumed, '2.000012');
  await db.query("UPDATE user_usage_limits SET basis='COST',token_limit=NULL,cost_limit=100 WHERE user_id=?", [otherUser]);
  await addEvent({ input: 1000, output: 1000, total: 2000 }, { status: 'UNSUPPORTED', known: '500' });
  await addEvent({ input: 1000, output: 1000, total: null }, { status: 'UNSUPPORTED', known: '500' }, new Date(), 'CANCELLED');
  await addEvent({ input: 10, output: 2, total: null }, { status: 'PARTIAL', known: '10' }, new Date(), 'CANCELLED');
  await addEvent({ input: 10, output: 2, total: null }, { status: 'UNPRICED' }, new Date(), 'CANCELLED');
  assert.equal((await usageLimitStatus(db, otherUser)).consumed, '1020.000000000000');
  await assert.rejects(enforceUsageLimit(db, otherUser), error => error.code === 'user_usage_limit_reached');
  assert.equal((await usageLimitStatus(db, otherUser, { now: tomorrow })).consumed, '0.000000000000');
  // Active and abandoned requests both count as zero until usable usage is recorded.
  const staleUser = (await db.query('INSERT INTO users(name,email) VALUES (?,?)', ['Stale', `${suffix}@stale.test`])).insertId;
  await db.query("INSERT INTO user_usage_limits(user_id,enabled,period,basis,token_limit) VALUES (?,TRUE,'DAILY','TOKENS',100)", [staleUser]);
  const staleStart = new Date();
  await db.query("INSERT INTO api_requests(request_id,user_id,endpoint,http_method,started_at,request_status,usage_expected) VALUES (?,?,'/v1/responses','POST',?,'FORWARDED',TRUE)", [randomUUID(), staleUser, staleStart]);
  assert.equal((await usageLimitStatus(db, staleUser, { now: staleStart })).blocked, false);
  assert.equal((await usageLimitStatus(db, staleUser, { now: new Date(staleStart.getTime() + 32000) })).blocked, false);
});
