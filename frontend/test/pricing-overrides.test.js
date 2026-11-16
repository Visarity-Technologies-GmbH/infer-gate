import test from 'node:test';
import assert from 'node:assert/strict';
import { applyClaudePricing, overrideValues, samePrice } from '../src/pages/pricing-overrides.js';

const row = (id, model = 'claude-fable-5-1') => ({
  id, model_pattern: model, input_price_per_million: '15.000000', output_price_per_million: '50.000000',
  cached_input_price_per_million: '1.000000', cache_write_price_per_million: '12.000000',
  cache_write_5m_rate: '10.000000', cache_write_1h_rate: '30.000000',
});
const price = (model = 'claude-fable-5-1', input = 10) => ({
  model, pricing: { input, output: 50, cache_read: 0.25, cache_write: null, cache_write_5m: 12.5, cache_write_1h: 20 },
});

test('stages all six fetched rates for matching overrides across providers without mutating input', () => {
  const rows = [row(1), { ...row(2, 'vendor/claude-fable-5-1-20261023'), provider_id: 2 }];
  const drafts = {};
  const result = applyClaudePricing(rows, drafts, [price()]);
  assert.equal(result.updatedCount, 2);
  for (const id of [1, 2]) assert.deepEqual(result.drafts[id], {
    input: '10', output: '50.000000', cache_read: '0.25', cache_write: '', cache_write_5m_rate: '12.5', cache_write_1h_rate: '20',
  });
  assert.deepEqual(drafts, {});
  assert.equal(rows[0].input_price_per_million, '15.000000');
});

test('longest literal model ID wins over a shorter contained model ID', () => {
  const result = applyClaudePricing([row(1, 'vendor/claude-opus-4-6')], {}, [price('claude-opus-4', 15), price('claude-opus-4-6', 5)]);
  assert.equal(result.drafts[1].input, '5');
});

test('unmatched edits remain untouched and matching does not normalize dots, hyphens or case', () => {
  const rows = [row(1, 'other-model'), row(2, 'claude-fable-5.1'), row(3, 'Claude-Fable-5.1')];
  const drafts = { 1: { ...overrideValues(rows[0]), input: '99' } };
  const result = applyClaudePricing(rows, drafts, [price()]);
  assert.deepEqual(result.drafts, drafts);
  assert.equal(result.updatedCount, 0);
});

test('matched manual edits are replaced; repeated updates do not count unchanged drafts again', () => {
  const rows = [row(1)];
  const drafts = { 1: { ...overrideValues(rows[0]), output: '99' } };
  const first = applyClaudePricing(rows, drafts, [price()]);
  assert.equal(first.drafts[1].output, '50.000000');
  assert.equal(drafts[1].output, '99');
  const second = applyClaudePricing(rows, first.drafts, [price()]);
  assert.equal(second.updatedCount, 0);
  assert.deepEqual(second.drafts, first.drafts);
});

test('unchanged prices create no draft and saving fetched values clears the dirty comparison', () => {
  const original = row(1);
  const result = applyClaudePricing([original], {}, [price()]);
  const saved = { ...original, input_price_per_million: '10.000000', cached_input_price_per_million: '0.250000', cache_write_price_per_million: null, cache_write_5m_rate: '12.500000', cache_write_1h_rate: '20.000000' };
  const values = overrideValues(saved);
  assert.ok(Object.keys(values).every(key => samePrice(values[key], result.drafts[1][key])));
  assert.deepEqual(applyClaudePricing([saved], {}, [price()]), { drafts: {}, updatedCount: 0 });
});

test('decimal comparison preserves zero versus unknown and exact precision', () => {
  assert.equal(samePrice('005.000', '5'), true);
  assert.equal(samePrice('0.000', '0'), true);
  assert.equal(samePrice('', '0'), false);
  assert.equal(samePrice(null, ''), true);
  assert.equal(samePrice('999999999999.000001', '999999999999.000002'), false);
});
