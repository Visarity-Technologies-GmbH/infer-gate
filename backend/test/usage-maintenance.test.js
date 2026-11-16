import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { maintainUsage } from '../src/services/usage-maintenance.js';
import { managerPermissions } from '../src/routes/manager.js';
import { database } from '../src/db/pool.js';
import { digest } from '../src/security/credentials.js';
import { randomUUID } from 'node:crypto';

async function serverFor(t, db) {
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return (path, method, body, credential = 'adm_test') => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
test('maintenance requires administrator auth and rejects invalid dates/fields before mutation', async t => {
  let mutations = 0;
  const db = { query: async sql => {
    assert.match(sql, /FROM admin_sessions/);
    return [{ token_hash: 'test' }];
  }, transaction: async () => { mutations++; throw new Error('Unexpected mutation'); } };
  const call = await serverFor(t, db);
  for (const [path, method, body] of [
    ['/admin/usage/events', 'DELETE', { before: '2026-01-01' }],
    ['/admin/usage/recalculate-costs', 'POST', { start: '2026-01-01', end: '2026-02-01' }],
  ]) {
    for (const credential of ['pak_test', 'uvk_test', 'mgr_test', ''])
      assert.equal((await call(path, method, body, credential)).status, 401);
    assert.throws(() => managerPermissions({ method, path: path.replace('/admin', ''), manager: {} }, {}, () => {}), { status: 403 });
  }
  for (const body of [{}, null, [], { before: 123 }, { before: '2026-02-30' },
    { before: '2026-01-01T25:00:00Z' }, { before: '2026-01-01T00:00:00' },
    { before: '2026-01-01', extra: true }, { before: '0999-01-01' }])
    assert.equal((await call('/admin/usage/events', 'DELETE', body)).status, 400);
  for (const body of [{ start: '2026-01-01' }, { start: '2026-02-01', end: '2026-01-01' },
    { start: '2026-01-01', end: '2026-01-01' }, { start: 'invalid', end: '2026-02-01' }])
    assert.equal((await call('/admin/usage/recalculate-costs', 'POST', body)).status, 400);
  assert.equal(mutations, 0);
});

test('deletion processes all batches in foreign-key order, with an exclusive cutoff and fixed maximum', async () => {
  const queries = [], batches = [[{ id: '1' }, { id: '2' }], [{ id: '3' }], [], [{ id: '10' }], []];
  let transactions = 0;
  const db = { query: async sql => [{ id: sql.includes('FROM api_requests') ? '10' : '3' }], transaction: async work => {
    transactions++;
    return work({ query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT')) return batches.shift();
      return { affectedRows: params.length };
    } });
  } };
  const before = new Date('2026-01-01T00:00:00Z');
  assert.deepEqual(await maintainUsage(db, { before }), { deleted_events: 3, deleted_costs: 3, deleted_requests: 1, completed: true });
  assert.equal(transactions, 5);
  assert.match(queries[0].sql, /timestamp<\?/);
  assert.deepEqual(queries[0].params, ['0', '3', before]);
  assert.match(queries[1].sql, /^DELETE FROM usage_costs/);
  assert.match(queries[2].sql, /^DELETE FROM usage_events/);
  assert.deepEqual(queries[3].params, ['2', '3', before]);
  assert.match(queries[7].sql, /NOT EXISTS.*SELECT 1 FROM usage_events/);
  assert.match(queries[8].sql, /^DELETE FROM api_requests/);
  assert.deepEqual(queries[7].params, ['0', '10', before]);
  assert.match(queries[7].sql, /'SUCCESS','FAILED','REJECTED','CANCELLED'/);
});

test('recalculation uses current prices and recovers eligible NULL comparisons', async () => {
  for (const { existingRequested, sameIdentity = false, missingPrice = false } of [
    { existingRequested: '1.000000000000' }, { existingRequested: '0.000000000000' },
    { existingRequested: null }, { existingRequested: null, sameIdentity: true },
    { existingRequested: null, missingPrice: true },
  ]) {
    const updates = [], pricingQueries = [];
    const events = [
      { id: '1', api_request_id: '10', provider_id: '20', requestedProvider_id: sameIdentity ? '20' : '30', model: 'cheap', requestedModel: sameIdentity ? 'cheap' : 'original',
        input_tokens: '1000', output_tokens: '50', cached_input_tokens: '200', cache_write_input_tokens: '100' },
      { id: '2' }, { id: '3' },
    ];
    let selected = false;
    const started_at = new Date('2025-12-01T00:00:00Z');
    const db = { query: async () => [{ id: '3' }], transaction: work => work({ query: async (sql, params) => {
      if (sql.startsWith('SELECT * FROM usage_events')) { const rows = selected ? [] : events; selected = true; return rows; }
      if (sql.includes('FROM usage_costs')) return params[0] === '3' ? [] : [{ id: params[0], status: params[0] === '2' ? 'UNSUPPORTED' : 'COMPLETE', requested_cost: existingRequested }];
      if (sql.includes('FROM api_requests')) return [{ started_at, endpoint: '/v1/chat/completions', api_type: 'ANTHROPIC' }];
      if (sql.includes('FROM model_pricing')) {
        pricingQueries.push(params);
        if (missingPrice && params[0] === '30') return [];
        return [{ id: '40', currency: 'USD', input_price_per_million: params[0] === '20' ? '2' : '4',
          output_price_per_million: '10', cached_input_price_per_million: '0.2', cache_write_price_per_million: '2.5' }];
      }
      if (sql.startsWith('UPDATE usage_costs')) { updates.push(params); return { affectedRows: 1 }; }
      throw new Error(`Unexpected query: ${sql}`);
    } }) };
    const result = await maintainUsage(db, { start: new Date('2026-01-01Z'), end: new Date('2026-02-01Z') });
    assert.deepEqual(result, { recalculated_events: 1, skipped_unsupported: 1, skipped_missing_assessment: 1, completed: true });
    assert.deepEqual(pricingQueries, sameIdentity
      ? [['20', 'cheap']]
      : [['20', 'cheap'], ['30', 'original']]);
    assert.equal(updates[0][5], '0.002190000000');
    assert.equal(updates[0][9], sameIdentity || missingPrice ? null : '0.003590000000');
    assert.equal(updates[0][7], 'COMPLETE');
    assert.equal(events[0].input_tokens, '1000');
  }
});

test('a failed batch reports only previously committed progress and cancellation stops before another batch', async () => {
  let calls = 0;
  const db = { query: async () => [{ id: 2 }], transaction: async work => {
    if (++calls === 2) throw new Error('database failure');
    return work({ query: async sql => sql.startsWith('SELECT') ? [{ id: 1 }] : { affectedRows: 1 } });
  } };
  await assert.rejects(maintainUsage(db, { before: new Date() }), error => {
    assert.deepEqual(error.maintenanceProgress, { deleted_events: 1, deleted_costs: 1, deleted_requests: 0, completed: false });
    return true;
  });
  calls = 0;
  assert.deepEqual(await maintainUsage(db, { before: new Date(), cancelled: () => calls === 1 }),
    { deleted_events: 1, deleted_costs: 1, deleted_requests: 0, completed: false });
});

test('MySQL maintenance routes preserve boundaries, price history, request cleanup and billing restrictions', {
  skip: !process.env.TEST_DB_NAME?.startsWith('infergate_test_'),
}, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD,
    database: process.env.TEST_DB_NAME, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
  t.after(() => db.close());
  const credential = `adm_${randomUUID()}`;
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))', [digest(credential)]);
  const call = await serverFor(t, db);
  const provider = await db.query("INSERT INTO llm_inference_providers(name,api_url,api_type) VALUES ('Maintenance','https://maintenance.example/v1','ANTHROPIC')");
  for (const [model, rate] of [['actual', '2'], ['original', '4']]) {
    await db.query(`INSERT INTO model_pricing(provider_id,model_pattern,input_price_per_million,output_price_per_million,
      cached_input_price_per_million,cache_write_price_per_million,currency)
      VALUES (?,?,?,10,0.2,2.5,'USD')`, [provider.insertId, model, rate]);
  }
  // Updating current price rows changes explicit recalculation without new versions.
  for (const [model, multiplier] of [['actual', 1], ['original', 2]]) {
    await db.query(`UPDATE model_pricing SET input_price_per_million=?,output_price_per_million=?,
      cached_input_price_per_million=?,cache_write_price_per_million=? WHERE provider_id=? AND model_pattern=?`,
    [4 * multiplier, 20 * multiplier, 0.4 * multiplier, 5 * multiplier, provider.insertId, model]);
  }
  const fixtures = [];
  for (const [timestamp, status] of [
    ['2001-01-01T23:59:59.999Z', 'COMPLETE'], ['2001-01-02T00:00:00.000Z', 'COMPLETE'],
    ['2001-01-02T12:00:00.000Z', 'UNSUPPORTED'], ['2001-01-02T13:00:00.000Z', null],
    ['2001-01-03T00:00:00.000Z', 'COMPLETE'],
  ]) {
    const request = await db.query(`INSERT INTO api_requests(request_id,endpoint,http_method,started_at,request_status)
      VALUES (?,'/v1/chat/completions','POST','2001-01-01','SUCCESS')`, [randomUUID()]);
    const event = await db.query(`INSERT INTO usage_events(api_request_id,provider_id,model,requestedModel,requestedProvider_id,
      input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,total_tokens,request_status,timestamp)
      VALUES (?,?,'actual','original',?,1000,200,100,50,1050,'SUCCESS',?)`,
    [request.insertId, provider.insertId, provider.insertId, new Date(timestamp)]);
    if (status) await db.query(`INSERT INTO usage_costs(usage_event_id,status,known_cost,requested_cost,currency,calculated_at)
      VALUES (?,?,99,?,'USD',UTC_TIMESTAMP(3))`, [event.insertId, status, status === 'COMPLETE' ? '88' : null]);
    fixtures.push({ request: request.insertId, event: event.insertId });
  }
  const response = await call('/admin/usage/recalculate-costs', 'POST', { start: '2001-01-02', end: '2001-01-03' }, credential);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { recalculated_events: 1, skipped_unsupported: 1, skipped_missing_assessment: 1, completed: true });
  const [cost] = await db.query('SELECT * FROM usage_costs WHERE usage_event_id=?', [fixtures[1].event]);
  assert.equal(cost.known_cost, '0.004380000000');
  assert.equal(cost.requested_cost, '0.008760000000');
  assert.equal(cost.status, 'COMPLETE');
  assert.equal(cost.input_cost, '0.002800000000');
  assert.equal(cost.cached_input_cost, '0.000080000000');
  assert.equal(cost.output_cost, '0.001000000000');
  assert.equal(cost.cache_write_cost, '0.000500000000');
  await db.query('UPDATE usage_costs SET requested_cost=NULL WHERE id=?', [cost.id]);
  for (const index of [0, 2, 4]) {
    const [untouched] = await db.query('SELECT known_cost,requested_cost FROM usage_costs WHERE usage_event_id=?', [fixtures[index].event]);
    assert.equal(untouched.known_cost, '99.000000000000');
    assert.equal(untouched.requested_cost, index === 2 ? null : '88.000000000000');
  }
  assert.equal((await call('/admin/usage/recalculate-costs', 'POST', { start: '2001-01-02T00:00:00Z', end: '2001-01-03T00:00:00.000Z' }, credential)).status, 200);
  const [preserved] = await db.query('SELECT known_cost,requested_cost FROM usage_costs WHERE id=?', [cost.id]);
  assert.equal(preserved.requested_cost, '0.008760000000');
  assert.equal(preserved.known_cost, '0.004380000000');
  // A missing requested price keeps the comparison NULL until a price is added.
  await db.query("UPDATE usage_events SET requestedModel='new-requested-model' WHERE id=?", [fixtures[1].event]);
  const recalculate = () => call('/admin/usage/recalculate-costs', 'POST', { start: '2001-01-02', end: '2001-01-03' }, credential);
  assert.equal((await recalculate()).status, 200);
  const [unpriced] = await db.query('SELECT requested_cost FROM usage_costs WHERE id=?', [cost.id]);
  assert.equal(unpriced.requested_cost, null);
  await db.query(`INSERT INTO model_pricing(provider_id,model_pattern,input_price_per_million,output_price_per_million,
    cached_input_price_per_million,cache_write_price_per_million,currency)
    VALUES (?,'new-requested-model',8,40,0.8,10,'USD')`, [provider.insertId]);
  assert.equal((await recalculate()).status, 200);
  const [recovered] = await db.query('SELECT requested_cost FROM usage_costs WHERE id=?', [cost.id]);
  assert.equal(recovered.requested_cost, '0.008760000000');
  await db.query("UPDATE usage_events SET requestedModel=model,requestedProvider_id=provider_id WHERE id=?", [fixtures[1].event]);
  assert.equal((await recalculate()).status, 200);
  const [unchangedIdentity] = await db.query('SELECT requested_cost FROM usage_costs WHERE id=?', [cost.id]);
  assert.equal(unchangedIdentity.requested_cost, null);
  const failingCall = await serverFor(t, { ...db, transaction: work => db.transaction(tx => work({ query: async (sql, params) => {
    if (sql.startsWith('DELETE FROM usage_events')) throw new Error('Simulated database failure');
    return tx.query(sql, params);
  } })) });
  const failed = await failingCall('/admin/usage/events', 'DELETE', { before: '2001-01-02' }, credential);
  assert.equal(failed.status, 500);
  const failure = await failed.json();
  assert.equal(failure.completed, false);
  assert.equal(failure.deleted_events, 0);
  assert.equal(failure.deleted_costs, 0);
  assert.equal(failure.error.code, 'usage_maintenance_failed');
  assert(!JSON.stringify(failure).includes('Simulated'));
  assert.equal((await db.query('SELECT id FROM usage_costs WHERE usage_event_id=?', [fixtures[0].event])).length, 1);
  const noUsage = [];
  for (const [status, started, completed = null] of [
    ['REJECTED', '2001-01-01'], ['FORWARDED', '2001-01-01'], ['RECEIVED', '2001-01-01'],
    ['REJECTED', '2001-01-02'], ['SUCCESS', '2001-01-01', '2001-01-03'],
  ]) {
    const request = await db.query(`INSERT INTO api_requests(request_id,endpoint,http_method,started_at,request_status,completed_at)
      VALUES (?,'/v1/chat/completions','POST',?,?,?)`, [randomUUID(), started, status, completed]);
    noUsage.push(request.insertId);
  }
  // The first request has an old start but a retained event at the cutoff.
  const deletion = await call('/admin/usage/events', 'DELETE', { before: '2001-01-02' }, credential);
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { deleted_events: 1, deleted_costs: 1, deleted_requests: 2, completed: true });
  assert.equal((await db.query('SELECT id FROM usage_events WHERE id=?', [fixtures[0].event])).length, 0);
  assert.equal((await db.query('SELECT id FROM usage_costs WHERE usage_event_id=?', [fixtures[0].event])).length, 0);
  assert.equal((await db.query('SELECT id FROM api_requests WHERE id=?', [fixtures[0].request])).length, 0);
  assert.equal((await db.query('SELECT id FROM usage_events WHERE id=?', [fixtures[1].event])).length, 1);
  assert.equal((await db.query('SELECT id FROM api_requests WHERE id=?', [fixtures[1].request])).length, 1);
  assert.equal((await db.query('SELECT id FROM api_requests WHERE id=?', [noUsage[0]])).length, 0);
  for (const id of noUsage.slice(1)) assert.equal((await db.query('SELECT id FROM api_requests WHERE id=?', [id])).length, 1);
  assert.deepEqual(await (await call('/admin/usage/events', 'DELETE', { before: '2001-01-02' }, credential)).json(),
    { deleted_events: 0, deleted_costs: 0, deleted_requests: 0, completed: true });
});


test('recalculation preserves duration counts and recomputes actual and requested duration costs', async () => {
  let selected = false, update;
  const event = { id: '1', provider_id: '2', api_request_id: '3', model: 'anthropic.actual', requestedModel: 'anthropic.requested', requestedProvider_id: '2',
    input_tokens: '51752', cached_input_tokens: '0', cache_write_input_tokens: '48640', cache_write_5m_tokens: '0', cache_write_1h_tokens: '48640', output_tokens: '14' };
  const db = { query: async () => [{ id: '1' }], transaction: work => work({ query: async (sql, params) => {
    if (sql.startsWith('SELECT * FROM usage_events')) { const rows = selected ? [] : [event]; selected = true; return rows; }
    if (sql.includes('FROM usage_costs')) return [{ id: '4', status: 'PARTIAL' }];
    if (sql.includes('FROM api_requests')) return [{ endpoint: '/v1/messages', api_type: 'AWS_BEDROCK' }];
    if (sql.includes('FROM model_pricing')) return [{ id: '5', currency: 'USD', input_price_per_million: '5', output_price_per_million: '25', cached_input_price_per_million: '0.5', cache_write_5m_rate: '6.25', cache_write_1h_rate: params[1] === 'anthropic.actual' ? '10' : '20' }];
    if (sql.startsWith('UPDATE usage_costs')) {
      const columns = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(',calculated_at')).split(',').map(part => part.trim().split('=')[0]);
      update = Object.fromEntries(columns.map((name, i) => [name, params[i]])); return { affectedRows: 1 };
    }
    throw new Error('Unexpected query');
  } }) };
  const result = await maintainUsage(db, { start: new Date('2026-01-01Z'), end: new Date('2027-01-01Z') });
  assert.equal(result.recalculated_events, 1); assert.equal(update.status, 'COMPLETE');
  assert.equal(update.known_cost, '0.502310000000'); assert.equal(update.requested_cost, '0.988710000000');
  assert.equal(update.cache_write_1h_cost, '0.486400000000'); assert.equal(update.cache_write_5m_cost, '0.000000000000');
  assert.equal(event.cache_write_1h_tokens, '48640');
});
