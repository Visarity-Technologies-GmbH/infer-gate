import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { database } from '../src/db/pool.js';
import { digest } from '../src/security/credentials.js';
import { startRequest, finalizeRequest } from '../src/services/tracking.js';
const enabled = process.env.TEST_DB_NAME?.startsWith('infergate_test_');
test('pricing endpoints reject unauthenticated administrators before fetching', async t => {
  let queries = 0, fetched = false;
  const db = { query: async () => { queries++; return []; } };
  const server = createApp(db, {}, { pricingFetchImpl: async () => { fetched = true; } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (const [path, method] of [['/pricing','GET'],['/pricing/import','POST'],['/pricing/providers/1','PUT'],['/pricing/overrides','POST'],['/pricing/overrides/1','DELETE']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, { method });
    assert.equal(response.status, 401);
  }
  assert.equal(queries, 0); assert.equal(fetched, false);
});
test('MySQL imports and overrides update current prices while stored costs remain unchanged', { skip: !enabled }, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, database: process.env.TEST_DB_NAME, timezone: 'Z' });
  const credential = `adm_${randomBytes(12).toString('hex')}`;
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))', [digest(credential)]);
  const provider = await db.query("INSERT INTO llm_inference_providers(name,api_url) VALUES ('Pricing test','https://pricing.example/v1')");
  const other = await db.query("INSERT INTO llm_inference_providers(name,api_url) VALUES ('Other pricing test','https://other.example/v1')");
  const user = await db.query("INSERT INTO users(name,email) VALUES ('Pricing test','pricing@example.test')");
  const key = await db.query("INSERT INTO proxy_api_keys(user_id,name,key_hash,key_prefix) VALUES (?,'Pricing test',?,'pak_price')", [user.insertId,digest(credential + 'proxy')]);
  const upstream = await db.query("INSERT INTO upstream_api_keys(provider_id,name,encrypted_api_key,key_fingerprint) VALUES (?,'Pricing test','test-encrypted','test-fingerprint')", [provider.insertId]);
  let generation = 0, input = 2, duration1h = 10, failFeed = false;
  const feed = () => ({ generated_at: new Date(Date.now() - 60000 + generation).toISOString(), models: [
    { provider: 'test', id: 'org/model', pricing: { input, output: 10, cache_read: 0.2, cache_write: 2.5, cache_write_5m: 6.25, cache_write_1h: duration1h } },
    { provider: 'other', id: 'org/model', pricing: { input: 100, output: 100, cache_read: 100, cache_write: null } }
  ] });
  let snapshot = JSON.stringify(feed());
  const server = createApp(db, {}, { pricingFetchImpl: async () => new Response(failFeed ? 'bad' : snapshot, { status: failFeed ? 503 : 200 }) }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); });
  const call = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const preview = await (await call('/pricing/import','POST',{preview:true})).json();
  assert.equal(preview.added, 2);
  assert.equal((await db.query('SELECT id FROM pricing_imports')).length, 0);
  let response = await call('/pricing/import','POST',{checksum:preview.checksum}); assert.equal(response.status, 200);
  assert.equal((await (await call('/pricing/import','POST',{})).json()).unchanged, true);
  assert.equal((await db.query('SELECT id FROM pricing_imports')).length, 1);
  const mapping = {provider_key:'test', aliases:[{model_id:'model',source_model_id:'org/model'}]};
  assert.equal((await call(`/pricing/providers/${provider.insertId}`,'PUT',mapping)).status, 204);
  assert.equal((await call(`/pricing/providers/${other.insertId}`,'PUT',{provider_key:'other',aliases:[]})).status, 204);
  assert.equal((await call(`/pricing/providers/${provider.insertId}`,'PUT',{provider_key:'test',aliases:[{model_id:'bad',source_model_id:'unknown'}]})).status, 400);
  async function record(model = 'model', overrides = {}) {
    const record = { request_id: randomBytes(12).toString('hex'), endpoint: '/v1/chat/completions', http_method: 'POST', started_at: new Date(), user_id: user.insertId, proxy_api_key_id: key.insertId, upstream_api_key_id: upstream.insertId, provider_id: provider.insertId, model_requested: model, request_status: 'SUCCESS', http_status: 200, ...overrides };
    await startRequest(db, record); return record;
  }
  const usage = { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 50, reasoning_tokens: 20, total_tokens: 1050 };
  const pending = await record();
  input = 4; generation++; snapshot = JSON.stringify(feed());
  assert.equal((await call('/pricing/import','POST',{})).status, 200);
  await finalizeRequest(db,pending,usage);
  const [historical] = await db.query('SELECT c.* FROM usage_costs c JOIN usage_events e ON e.id=c.usage_event_id WHERE e.api_request_id=?',[pending.id]);
  assert.equal(historical.known_cost, '0.003740000000');
  assert.equal(historical.status, 'COMPLETE');
  const fresh = await record(); await finalizeRequest(db,fresh,usage);
  const [newCost] = await db.query('SELECT c.* FROM usage_costs c JOIN usage_events e ON e.id=c.usage_event_id WHERE e.api_request_id=?',[fresh.id]);
  assert.equal(newCost.known_cost, '0.003740000000');
  assert.equal(newCost.pricing_id,historical.pricing_id);
  failFeed = true;
  assert.equal((await call('/pricing/import','POST',{})).status, 502);
  failFeed = false;
  assert.equal((await call('/pricing/overrides','POST',{provider_id:provider.insertId,model_id:'model',input:'1',output:'1',cache_read:'1',cache_write:null})).status, 201);
  const manual = await record(); await finalizeRequest(db,manual,usage);
  const [manualCost] = await db.query('SELECT c.* FROM usage_costs c JOIN usage_events e ON e.id=c.usage_event_id WHERE e.api_request_id=?',[manual.id]);
  assert.equal(manualCost.known_cost,'0.001050000000');
  assert.equal((await call('/pricing/overrides','POST',{provider_id:provider.insertId,model_id:'model',input:'2',output:'2',cache_read:'2',cache_write:null})).status, 201);
  const [editedOverride] = await db.query("SELECT id,input_price_per_million FROM model_pricing WHERE provider_id=? AND model_pattern='model' AND source_kind='MANUAL'", [provider.insertId]);
  assert.equal(editedOverride.id, manualCost.pricing_id);
  assert.equal(editedOverride.input_price_per_million, '2.00000000');
  assert.equal((await call(`/pricing/overrides/${manualCost.pricing_id}`,'DELETE')).status, 204);
  const [detached] = await db.query('SELECT pricing_id,known_cost FROM usage_costs WHERE id=?', [manualCost.id]);
  assert.equal(detached.pricing_id, null);
  assert.equal(detached.known_cost, manualCost.known_cost);
  assert.equal((await db.query('SELECT id FROM model_pricing WHERE id=?', [manualCost.pricing_id])).length, 0);
  const unknown = await record('unknown'); await finalizeRequest(db,unknown,usage);
  const partial = await record(); await finalizeRequest(db,partial,{...usage,output_tokens:null});
  const assumedCache = await record(); await finalizeRequest(db,assumedCache,{...usage,cached_input_tokens:null});
  const [assumedEvent] = await db.query('SELECT e.cached_input_tokens,c.status,c.cached_input_cost,c.known_cost FROM usage_events e JOIN usage_costs c ON c.usage_event_id=e.id WHERE e.api_request_id=?',[assumedCache.id]);
  assert.equal(assumedEvent.cached_input_tokens,null);
  assert.equal(assumedEvent.status,'COMPLETE');
  assert.equal(assumedEvent.cached_input_cost,'0.000000000000');
  assert.equal(assumedEvent.known_cost,'0.004500000000');
  const report = await (await call(`/usage?group_by=company&provider_id=${provider.insertId}`)).json();
  assert.equal(report.data[0].usage_events,6);
  assert.equal(report.data[0].total_tokens,'6300');
  assert.equal(report.data[0].priced_events,4);
  assert.equal(report.data[0].partial_events,1);
  assert.equal(report.data[0].unpriced_events,1);
  assert.equal(report.data[0].costs[0].estimated_cost,'0.013030000000');
  const listing = await (await call('/pricing')).json();
  assert.equal(listing.latest.model_count,2);
  assert.equal(listing.aliases.find(row => String(row.provider_id) === String(provider.insertId)).source_model_id,'org/model');
  assert.equal(listing.catalog.find(row => row.provider_key === 'test').cache_write_1h_rate, '10.00000000');
  const [mappedDuration] = await db.query('SELECT cache_write_5m_rate,cache_write_1h_rate FROM model_pricing WHERE id=?', [newCost.pricing_id]);
  assert.equal(mappedDuration.cache_write_5m_rate, '6.25000000');
  assert.equal(mappedDuration.cache_write_1h_rate, '10.00000000');
  duration1h = 12; generation++; snapshot = JSON.stringify(feed());
  const durationPreview = await (await call('/pricing/import', 'POST', { preview: true })).json();
  assert.equal(durationPreview.changed, 1);
  assert.equal((await call('/pricing/import', 'POST', { checksum: durationPreview.checksum })).status, 200);
  const [changedDuration] = await db.query("SELECT cache_write_1h_rate FROM model_pricing WHERE provider_id=? AND model_pattern='model' ", [provider.insertId]);
  assert.equal(changedDuration.cache_write_1h_rate, '12.00000000');
  assert.equal(historical.requested_cost, null);
  assert.equal((await call('/pricing/overrides','POST',{provider_id:other.insertId,model_id:'requested',input:'100',output:'200',cache_read:'10',cache_write:'300'})).status, 201);
  const remapped = await record('requested', { requestedProvider_id: other.insertId, model_resolved: 'model' });
  await finalizeRequest(db, remapped, { ...usage, cache_write_input_tokens: 100 });
  const [comparison] = await db.query('SELECT c.* FROM usage_costs c JOIN usage_events e ON e.id=c.usage_event_id WHERE e.api_request_id=?', [remapped.id]);
  assert.equal(comparison.status, 'COMPLETE');
  assert.equal(comparison.known_cost, '0.003740000000');
  assert.equal(comparison.requested_cost, '0.112000000000');
  // Optional duration rates round-trip through manual overrides and recorded usage.
  const durationBody = { provider_id: provider.insertId, model_id: 'anthropic.duration-test', input: '5', output: '25', cache_read: '0.5', cache_write: '6.25', cache_write_5m_rate: '6.25', cache_write_1h_rate: '10' };
  assert.equal((await call('/pricing/overrides', 'POST', { ...durationBody, cache_write_1h_rate: '-1' })).status, 400);
  assert.equal((await call('/pricing/overrides', 'POST', durationBody)).status, 201);
  const durationListing = await (await call('/pricing')).json();
  const durationOverride = durationListing.overrides.find(row => row.model_pattern === durationBody.model_id);
  assert.equal(durationOverride.cache_write_5m_rate, '6.25000000');
  assert.equal(durationOverride.cache_write_1h_rate, '10.00000000');
  const durationRecord = await record(durationBody.model_id, { api_type: 'AWS_BEDROCK', endpoint: '/v1/messages' });
  await finalizeRequest(db, durationRecord, { input_tokens: 51752, cached_input_tokens: 0, cache_write_input_tokens: 48640,
    cache_write_5m_tokens: 0, cache_write_1h_tokens: 48640, output_tokens: 14, reasoning_tokens: 0, total_tokens: 51766 });
  const [durationCost] = await db.query('SELECT c.*,e.cache_write_5m_tokens,e.cache_write_1h_tokens FROM usage_costs c JOIN usage_events e ON e.id=c.usage_event_id WHERE e.api_request_id=?', [durationRecord.id]);
  assert.equal(durationCost.cache_write_5m_tokens, 0); assert.equal(durationCost.cache_write_1h_tokens, 48640);
  assert.equal(durationCost.known_cost, '0.502310000000'); assert.equal(durationCost.cache_write_1h_cost, '0.486400000000');
  assert.equal(durationCost.cache_write_5m_cost, '0.000000000000'); assert.equal(durationCost.status, 'COMPLETE');
  // Maintenance permits usage/cost/price changes; foreign keys remain.
  await db.transaction(async tx => {
    assert.equal((await tx.query('UPDATE usage_events SET total_tokens=0 WHERE id=?', [comparison.usage_event_id])).affectedRows, 1);
    const [updatedEvent] = await tx.query('SELECT total_tokens FROM usage_events WHERE id=?', [comparison.usage_event_id]);
    assert.equal(updatedEvent.total_tokens, 0);
    assert.equal((await tx.query('UPDATE usage_costs SET known_cost=99,requested_cost=0 WHERE id=?', [comparison.id])).affectedRows, 1);
    const [updated] = await tx.query('SELECT known_cost,requested_cost FROM usage_costs WHERE id=?', [comparison.id]);
    assert.equal(updated.known_cost, '99.000000000000');
    assert.equal(updated.requested_cost, '0.000000000000');
    await assert.rejects(tx.query('DELETE FROM api_requests WHERE id=?', [remapped.id]), { code: 'ER_ROW_IS_REFERENCED_2' });
    await assert.rejects(tx.query('DELETE FROM usage_events WHERE id=?', [comparison.usage_event_id]), { code: 'ER_ROW_IS_REFERENCED_2' });
    await assert.rejects(tx.query('DELETE FROM model_pricing WHERE id=?', [comparison.pricing_id]), { code: 'ER_ROW_IS_REFERENCED_2' });
    assert.equal((await tx.query('DELETE FROM usage_costs WHERE id=?', [comparison.id])).affectedRows, 1);
    assert.equal((await tx.query('DELETE FROM usage_events WHERE id=?', [comparison.usage_event_id])).affectedRows, 1);
    assert.equal((await tx.query('DELETE FROM api_requests WHERE id=?', [remapped.id])).affectedRows, 1);
  });
  assert.equal((await call(`/pricing/providers/${provider.insertId}`, 'PUT', { provider_key: null, aliases: [] })).status, 204);
  assert.equal((await db.query("SELECT id FROM model_pricing WHERE provider_id=? AND source_kind='FEED'", [provider.insertId])).length, 0);
  const [unmapped] = await db.query('SELECT pricing_id,known_cost FROM usage_costs WHERE id=?', [newCost.id]);
  assert.equal(unmapped.pricing_id, null);
  assert.equal(unmapped.known_cost, newCost.known_cost);
});

test('MySQL pricing maintenance allows rate/provenance updates and deletion', { skip: !enabled }, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD,
    database: process.env.TEST_DB_NAME, timezone: 'Z' });
  t.after(() => db.close());
  const provider = await db.query("INSERT INTO llm_inference_providers(name,api_url) VALUES ('Mutable prices','https://pricing-maintenance.example/v1')");
  const price = await db.query(`INSERT INTO model_pricing(provider_id,model_pattern,currency)
    VALUES (?,'original','USD')`, [provider.insertId]);
  assert.equal((await db.query(`UPDATE model_pricing SET model_pattern='renamed',currency='EUR',
    input_price_per_million=1,output_price_per_million=2,cached_input_price_per_million=3,
    cache_write_price_per_million=4,cache_write_5m_rate=5,cache_write_1h_rate=6,
    source_model_id='administrator-edit' WHERE id=?`, [price.insertId])).affectedRows, 1);
  const [updated] = await db.query('SELECT * FROM model_pricing WHERE id=?', [price.insertId]);
  assert.equal(updated.model_pattern, 'renamed');
  assert.equal(updated.currency, 'EUR');
  for (const [column, rate] of [['input_price_per_million', 1], ['output_price_per_million', 2],
    ['cached_input_price_per_million', 3], ['cache_write_price_per_million', 4], ['cache_write_5m_rate', 5], ['cache_write_1h_rate', 6]])
    assert.equal(updated[column], `${rate}.00000000`);
  assert.equal(updated.source_model_id, 'administrator-edit');
  assert(!Object.hasOwn(updated, 'valid_from'));
  assert(!Object.hasOwn(updated, 'valid_until'));
  assert.equal((await db.query('DELETE FROM model_pricing WHERE id=?', [price.insertId])).affectedRows, 1);
  assert.equal((await db.query('SELECT id FROM model_pricing WHERE id=?', [price.insertId])).length, 0);
});
