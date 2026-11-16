import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost, estimateCost, normalizeRate, recordCost, supportsTokenBilling } from '../src/services/accounting.js';
import { extractUsage, UsageCollector } from '../src/services/usage.js';
import { anthropicUsage } from '../src/providers/anthropic.js';
import { fetchCatalog, parseCatalog, PRICING_URL } from '../src/services/pricing.js';
const price = { input_price_per_million: '2.00000000', cached_input_price_per_million: '0.20000000', cache_write_price_per_million: '2.50000000', output_price_per_million: '10.00000000' };
const usage = { input_tokens: 1000, cached_input_tokens: 200, cache_write_input_tokens: 100, output_tokens: 50, reasoning_tokens: 20 };
async function recordedCost({ actual = price, requested = price, counts = usage, record = {} } = {}) {
  const queries = [];
  let inserted;
  const tx = { query: async (sql, params) => {
    if (sql.startsWith('SELECT')) {
      queries.push(params);
      const pricing = queries.length === 1 ? actual : requested;
      return pricing ? [{ id: queries.length, currency: 'USD', ...pricing }] : [];
    }
    const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',');
    assert.equal(params.length, columns.length - 1); // calculated_at is a SQL expression.
    inserted = Object.fromEntries(columns.slice(0, -1).map((name, index) => [name, params[index]]));
  } };
  const started_at = new Date('2026-10-20T00:00:00Z');
  await recordCost(tx, 1, { provider_id: 10, requestedProvider_id: 20, model_requested: 'original', started_at, endpoint: '/v1/chat/completions', ...record }, counts, 'resolved');
  return { inserted, queries, started_at };
}
test('Bedrock token estimates use configured prices for native Messages and OpenAI-compatible endpoints', async () => {
  for (const endpoint of ['/v1/messages', '/v1/messages/', '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings']) {
    const native = endpoint.startsWith('/v1/messages');
    const { inserted, queries, started_at } = await recordedCost({ record: {
      api_type: 'AWS_BEDROCK', endpoint, model_resolved: native ? 'anthropic.claude-opus-4-7' : 'other-model',
    } });
    assert.equal(inserted.status, 'COMPLETE');
    assert.equal(inserted.input_cost, native ? '0.001400000000' : '0.001600000000');
    assert.equal(inserted.cached_input_cost, '0.000040000000');
    assert.equal(inserted.cache_write_cost, native ? '0.000250000000' : '0.000000000000');
    assert.equal(inserted.output_cost, '0.000500000000');
    assert.equal(inserted.known_cost, native ? '0.002190000000' : '0.002140000000');
    assert.equal(inserted.requested_cost, '0.002190000000');
    assert.deepEqual(queries[0], [10, 'resolved']);
  }
});
test('Bedrock native cache accounting also applies when recalculating a recorded Claude model', async () => {
  const queries = [];
  const tx = { query: async (sql, params) => { queries.push(params); return [{ ...price, id: 1, currency: 'USD' }]; } };
  const cost = await calculateCost(tx, { api_type: 'AWS_BEDROCK', provider_id: 10, requestedProvider_id: 10,
    model_requested: 'anthropic.claude-opus-4-7', endpoint: '/v1/messages' }, usage, 'anthropic.claude-opus-4-7');
  assert.equal(cost.status, 'COMPLETE'); assert.equal(cost.known_cost, '0.002190000000');
  assert.deepEqual(queries, [[10, 'anthropic.claude-opus-4-7']]);
});
test('Bedrock retains unpriced, partial and unsupported billing assessments', async () => {
  const record = { api_type: 'AWS_BEDROCK', endpoint: '/v1/messages', model_resolved: 'anthropic.claude-opus-4-7' };
  for (const [options, status] of [
    [{ actual: null }, 'UNPRICED'],
    [{ counts: { ...usage, cache_write_input_tokens: -1 } }, 'PARTIAL'],
    [{ actual: { ...price, cache_write_price_per_million: null } }, 'PARTIAL'],
    [{ counts: { ...usage, billing_unsupported: true } }, 'UNSUPPORTED'],
    [{ actual: { ...price, subscription: 1 } }, 'UNSUPPORTED'],
    [{ record: { ...record, cost_supported: false } }, 'UNSUPPORTED'],
    [{ record: { ...record, endpoint: '/v1/images/generations' } }, 'UNSUPPORTED'],
  ]) {
    const { inserted } = await recordedCost({ record, ...options });
    assert.equal(inserted.status, status); assert.equal(inserted.requested_cost, null);
  }
});
test('requested cost uses requested provider/model, all four counts and current pricing', async () => {
  const requested = { ...price, input_price_per_million: '4', output_price_per_million: '20' };
  const { inserted, queries, started_at } = await recordedCost({ requested });
  assert.deepEqual(queries, [[10, 'resolved'], [20, 'original']]);
  assert.equal(inserted.status, 'COMPLETE');
  assert.equal(inserted.known_cost, '0.002140000000');
  assert.equal(inserted.requested_cost, '0.004090000000');
});
test('requested cost treats missing cache counts as zero without changing usage', async () => {
  const counts = { ...usage, cached_input_tokens: null, cache_write_input_tokens: null };
  const { inserted } = await recordedCost({ counts });
  assert.equal(inserted.requested_cost, '0.002500000000');
  assert.equal(counts.cached_input_tokens, null);
  assert.equal(counts.cache_write_input_tokens, null);
  const zero = await recordedCost({ counts: { input_tokens: 0, output_tokens: 0, cached_input_tokens: null, cache_write_input_tokens: null } });
  assert.equal(zero.inserted.requested_cost, '0.000000000000');
});
test('incomplete actual assessments skip requested pricing and retain NULL', async () => {
  for (const options of [{ actual: null }, { counts: { ...usage, output_tokens: null } }, { record: { cost_supported: false } }]) {
    const { inserted, queries } = await recordedCost(options);
    assert.notEqual(inserted.status, 'COMPLETE');
    assert.equal(inserted.requested_cost, null);
    assert.equal(queries.length, 1);
  }
});
test('requested cost requires a different model or a different provider', async () => {
  for (const record of [
    { model_requested: 'resolved' },
    { requestedProvider_id: 10 },
    { requestedProvider_id: '10' },
    { provider_id: '20' },
  ]) {
    const { inserted, queries } = await recordedCost({ record });
    assert.equal(inserted.status, 'COMPLETE');
    assert.equal(inserted.requested_cost, '0.002190000000');
    assert.equal(queries.length, 2);
  }
  for (const requestedProvider_id of [10, '10']) {
    const { inserted, queries } = await recordedCost({ record: { model_requested: 'resolved', requestedProvider_id } });
    assert.equal(inserted.status, 'COMPLETE');
    assert.equal(inserted.requested_cost, null);
    assert.equal(queries.length, 1);
  }
});
test('unavailable, incomplete or incompatible requested pricing retains NULL', async () => {
  for (const requested of [null, { ...price, cached_input_price_per_million: null }, { ...price, subscription: 1 }, { ...price, currency: 'EUR' }]) {
    const { inserted } = await recordedCost({ requested });
    assert.equal(inserted.status, 'COMPLETE');
    assert.equal(inserted.requested_cost, null);
  }
  for (const record of [{ requestedProvider_id: null }, { model_requested: null }]) {
    const { inserted, queries } = await recordedCost({ record });
    assert.equal(inserted.requested_cost, null);
    assert.equal(queries.length, 1);
  }
});
test('decimal price normalization and cost rounding use exact integer arithmetic', () => {
  assert.equal(normalizeRate(0.060000000000000005), '0.06000000');
  assert.equal(normalizeRate('1e-8'), '0.00000001');
  assert.equal(normalizeRate('1.123456785'), '1.12345679');
  for (const invalid of [-1, Infinity, NaN, undefined, {}, '1e999', '1000000000000']) assert.throws(() => normalizeRate(invalid));
  const result = estimateCost({ input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 }, { ...price, input_price_per_million: '0.00000050' });
  assert.equal(result.input_cost, '0.000000000001');
});
test('cache reads and reasoning are never double billed', () => {
  const result = estimateCost(usage, price);
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.known_cost, '0.002140000000');
  assert.equal(result.output_cost, '0.000500000000');
  assert.equal(result.cache_write_cost, '0.000000000000');
});
test('Anthropic cache reads and creation are separate from uncached input', () => {
  const normalized = extractUsage({ model: 'claude', usage: anthropicUsage({ input_tokens: 700, cache_read_input_tokens: 200, cache_creation_input_tokens: 100, output_tokens: 50 }) });
  assert.equal(normalized.input_tokens, 1000); assert.equal(normalized.cache_write_input_tokens, 100);
  assert.equal(estimateCost(normalized, price, { anthropic: true }).known_cost, '0.002190000000');
});
test('unreported cache reads are assumed zero only in the cost calculation', () => {
  for (const cached_input_tokens of [null, undefined, 0]) {
    const event = { ...usage, cached_input_tokens };
    const result = estimateCost(event, { ...price, cached_input_price_per_million: null });
    assert.equal(result.status, 'COMPLETE');
    assert.equal(result.input_cost, '0.002000000000');
    assert.equal(result.cached_input_cost, '0.000000000000');
    assert.equal(result.known_cost, '0.002500000000');
    assert.equal(event.cached_input_tokens, cached_input_tokens);
  }
  assert.equal(estimateCost({ ...usage, cached_input_tokens: null }, price, { anthropic: true }).known_cost, '0.002550000000');
  assert.equal(estimateCost({ ...usage, cached_input_tokens: null, cache_write_input_tokens: null }, price, { anthropic: true }).known_cost, '0.002500000000');
  for (const cached_input_tokens of [-1, 0.5, '0']) assert.equal(estimateCost({ ...usage, cached_input_tokens }, price).status, 'PARTIAL');
});
test('unreported cache writes are zero for native accounting and recalculation without changing usage', async () => {
  for (const cache_write_input_tokens of [null, undefined, 0]) {
    const event = { ...usage, cache_write_input_tokens };
    for (const api_type of ['ANTHROPIC', 'OPENAI_ANTHROPIC', 'AWS_BEDROCK']) {
      const tx = { query: async () => [{ ...price, cache_write_price_per_million: null, id: 1, currency: 'USD' }] };
      const record = { api_type, provider_id: 10, requestedProvider_id: 10, model_requested: 'anthropic.claude', endpoint: '/v1/messages', started_at: new Date() };
      const result = await calculateCost(tx, record, event, 'anthropic.claude');
      assert.equal(result.status, 'COMPLETE');
      assert.equal(result.input_cost, '0.001600000000');
      assert.equal(result.cached_input_cost, '0.000040000000');
      assert.equal(result.cache_write_cost, '0.000000000000');
      assert.equal(result.known_cost, '0.002140000000');
      assert.equal(event.cache_write_input_tokens, cache_write_input_tokens);
    }
  }
  for (const cache_write_input_tokens of [-1, 0.5, '0']) {
    assert.equal(estimateCost({ ...usage, cache_write_input_tokens }, price, { anthropic: true }).status, 'PARTIAL');
  }
});
test('unknown usage and unknown rates stay partial; reported zero has zero cost', () => {
  const partial = estimateCost({ ...usage, input_tokens: null }, price);
  assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.known_cost, '0.000500000000');
  const missingCachePrice = estimateCost(usage, { ...price, cached_input_price_per_million: null });
  assert.equal(missingCachePrice.status, 'PARTIAL');
  assert.equal(missingCachePrice.known_cost, '0.002100000000');
  const zero = estimateCost({ input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, { input_price_per_million: null, output_price_per_million: null });
  assert.equal(zero.known_cost, '0.000000000000');
  assert.equal(estimateCost(usage, null).status, 'UNPRICED');
  assert.equal(estimateCost(usage, price, { supported: false }).status, 'UNSUPPORTED');
  assert.equal(estimateCost(usage, { ...price, subscription: 1 }).status, 'UNSUPPORTED');
  assert.equal(estimateCost({ ...usage, cached_input_tokens: 1001 }, price).status, 'PARTIAL');
});
test('special service tiers remain unsupported independently of cache duration', () => {
  const collector = new UsageCollector('text/event-stream');
  collector.push(Buffer.from('data: {"service_tier":"priority"}\n\ndata: {"usage":{"prompt_tokens":1}}\n\n'));
  assert.equal(collector.usage.billing_unsupported, true);
  const normalized = extractUsage({ usage: anthropicUsage({ input_tokens: 1, cache_creation_input_tokens: 1, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1 }, output_tokens: 1 }) });
  assert.equal(estimateCost(normalized, price, { anthropic: true }).status, 'PARTIAL');
});
const catalogText = () => JSON.stringify({ generated_at: new Date().toISOString(), models: [{ provider: 'test', id: 'model', pricing: { input: 2, output: 10, cache_read: null, cache_write: null } }] });
test('feed validation preserves nulls and rejects invalid or duplicate records', () => {
  const catalog = parseCatalog(catalogText());
  assert.deepEqual(catalog.models[0].rates, ['2.00000000','10.00000000',null,null,null,null]);
  const source = JSON.parse(catalogText()); source.models.push(source.models[0]);
  assert.throws(() => parseCatalog(JSON.stringify(source)), { code: 'invalid_pricing_feed' });
  source.models.pop(); source.models[0].pricing.input = -1;
  assert.throws(() => parseCatalog(JSON.stringify(source)), { code: 'invalid_pricing_feed' });
});
test('pricing download uses the fixed source without credentials and fails safely', async () => {
  let calls = 0;
  const result = await fetchCatalog(async (url, init) => { calls++; assert.equal(url, PRICING_URL); assert.equal(init.redirect, 'error'); assert.equal(init.headers.authorization, undefined); return new Response(catalogText()); });
  assert.equal(result.models.length, 1); assert.equal(calls, 1);
  await assert.rejects(fetchCatalog(async () => new Response('', { status: 500 })), { code: 'pricing_fetch_failed' });
  await assert.rejects(fetchCatalog(async () => { throw new Error('sensitive-network-detail'); }), { message: 'Unable to download TokenWatch pricing; existing prices were retained' });
});

test('cost support checks metadata without changing proxy forwarding or prompt contents', () => {
  assert(supportsTokenBilling({ messages: [{ content: [{type:'text',text:'test'}] }], tools:[{type:'function'}] }));
  for (const body of [{ service_tier:'priority' }, { tools:[{type:'web_search'}] }, { input:[{type:'input_image'}] }, { messages:[{content:[{type:'image_url'}]}] }, { modalities:['audio'] }]) assert.equal(supportsTokenBilling(body), false);
});

const durationPrice = { input_price_per_million: '5', output_price_per_million: '25',
  cached_input_price_per_million: '0.5', cache_write_price_per_million: '6.25',
  cache_write_5m_rate: '6.25', cache_write_1h_rate: '10' };
const durationUsage = () => extractUsage({ usage: anthropicUsage({ input_tokens: 3112,
  cache_creation_input_tokens: 48640, cache_read_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 48640 },
  output_tokens: 14, service_tier: 'standard', output_tokens_details: { thinking_tokens: 0 } }) });
test('one-hour Claude writes retain counters and cost exactly $0.50231 without double billing', async () => {
  const counts = durationUsage();
  assert.equal(counts.cache_write_5m_tokens, 0); assert.equal(counts.cache_write_1h_tokens, 48640);
  assert.equal(counts.input_tokens, 51752); assert.equal(counts.total_tokens, 51766);
  const { inserted } = await recordedCost({ actual: durationPrice, requested: { ...durationPrice, cache_write_1h_rate: '20' }, counts,
    record: { api_type: 'AWS_BEDROCK', endpoint: '/v1/messages', model_resolved: 'anthropic.claude-test' } });
  assert.equal(inserted.status, 'COMPLETE');
  assert.equal(inserted.input_cost, '0.015560000000');
  assert.equal(inserted.cache_write_5m_cost, '0.000000000000');
  assert.equal(inserted.cache_write_1h_cost, '0.486400000000');
  assert.equal(inserted.cache_write_cost, '0.486400000000');
  assert.equal(inserted.known_cost, '0.502310000000');
  assert.equal(inserted.requested_cost, '0.988710000000');
});
test('mixed cache durations use their specific rates, with generic fallback only for five-minute writes', () => {
  const counts = { input_tokens: 1000, cached_input_tokens: 100, cache_write_input_tokens: 500,
    cache_write_5m_tokens: 200, cache_write_1h_tokens: 300, output_tokens: 10 };
  const cost = estimateCost(counts, durationPrice, { anthropic: true });
  assert.equal(cost.status, 'COMPLETE');
  assert.equal(cost.cache_write_5m_cost, '0.001250000000');
  assert.equal(cost.cache_write_1h_cost, '0.003000000000');
  assert.equal(cost.cache_write_cost, '0.004250000000');
  assert.equal(cost.known_cost, '0.006550000000');
  assert.equal(estimateCost(counts, { ...durationPrice, cache_write_5m_rate: null }, { anthropic: true }).known_cost, cost.known_cost);
  const partial = estimateCost(counts, { ...durationPrice, cache_write_1h_rate: null }, { anthropic: true });
  assert.equal(partial.status, 'PARTIAL'); assert.equal(partial.cache_write_cost, null);
  assert.equal(partial.cache_write_1h_cost, null); assert.equal(partial.known_cost, '0.003550000000');
  assert.equal(estimateCost(counts, { ...durationPrice, cache_write_5m_rate: '0' }, { anthropic: true }).cache_write_5m_cost, '0.000000000000');
  for (const changes of [{ cache_write_1h_tokens: 400 }, { cache_write_5m_tokens: null }, { cache_write_1h_tokens: -1 }])
    assert.equal(estimateCost({ ...counts, ...changes }, durationPrice, { anthropic: true }).status, 'PARTIAL');
});
test('duration counters survive native JSON, native SSE and normalized Chat usage collection', () => {
  const raw = { input_tokens: 3112, cache_creation_input_tokens: 48640, cache_read_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 48640 }, output_tokens: 0 };
  for (const stream of [false, true]) {
    const collector = new UsageCollector(stream ? 'text/event-stream' : 'application/json', undefined, 'ANTHROPIC');
    collector.push(Buffer.from(stream ? `data: ${JSON.stringify({ type: 'message_start', message: { usage: raw } })}\n\ndata: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 14 } })}\n\n` : JSON.stringify({ usage: { ...raw, output_tokens: 14 } })));
    collector.finish();
    assert.deepEqual(collector.usage, { ...durationUsage(), model: null, reasoning_tokens: null });
  }
  const collector = new UsageCollector('application/json');
  collector.push(Buffer.from(JSON.stringify({ usage: anthropicUsage(raw) }))); collector.finish();
  assert.equal(collector.usage.cache_write_1h_tokens, 48640);
});
test('pricing feeds import optional duration rates and reject malformed supplied rates', () => {
  const source = JSON.parse(catalogText());
  source.models[0].pricing.cache_write_5m = '6.25'; source.models[0].pricing.cache_write_1h = '10';
  assert.deepEqual(parseCatalog(JSON.stringify(source)).models[0].rates.slice(4), ['6.25000000', '10.00000000']);
  source.models[0].pricing.cache_write_1h = -1;
  assert.throws(() => parseCatalog(JSON.stringify(source)), { code: 'invalid_pricing_feed' });
});

test('requested cost retains NULL when requested pricing cannot price reported one-hour writes', async () => {
  const { inserted } = await recordedCost({ actual: durationPrice, requested: { ...durationPrice, cache_write_1h_rate: null },
    counts: durationUsage(), record: { api_type: 'ANTHROPIC', endpoint: '/v1/messages' } });
  assert.equal(inserted.status, 'COMPLETE'); assert.equal(inserted.known_cost, '0.502310000000');
  assert.equal(inserted.requested_cost, null);
});


test('dual provider accounting selects cache-write semantics by endpoint, including recalculation', async () => {
  for (const endpoint of ['/v1/messages', '/v1/messages/', '/v1/chat/completions', '/v1/responses']) {
    const native = endpoint.startsWith('/v1/messages');
    const { inserted } = await recordedCost({ record: { api_type: 'OPENAI_ANTHROPIC', endpoint } });
    assert.equal(inserted.status, 'COMPLETE');
    assert.equal(inserted.known_cost, native ? '0.002190000000' : '0.002140000000');
    const tx = { query: async () => [{ ...price, id: 1, currency: 'USD' }] };
    const cost = await calculateCost(tx, { api_type: 'OPENAI_ANTHROPIC', endpoint, provider_id: 10,
      requestedProvider_id: 10, model_requested: 'same' }, usage, 'same');
    assert.equal(cost.known_cost, inserted.known_cost);
  }
});
