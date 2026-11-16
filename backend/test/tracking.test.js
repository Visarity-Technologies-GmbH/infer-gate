import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeRequest } from '../src/services/tracking.js';

test('usage events capture the original requested model separately from the resolved model', async () => {
  for (const [requested, resolved] of [['original-model', 'selected-model'], ['original-model', undefined], [undefined, undefined]]) {
    let event;
    const db = {
      transaction: fn => fn({ query: async (sql, params) => {
        if (sql.startsWith('INSERT INTO usage_events')) {
          const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',');
          assert.equal(columns.length, params.length);
          event = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
          return { insertId: 1 };
        }
        if (sql.startsWith('SELECT * FROM model_pricing')) return [];
        return { affectedRows: 1 };
      } }),
    };
    await finalizeRequest(db, { id: 1, model_requested: requested, requestedProvider_id: requested ? 7 : undefined, provider_id: 8, model_resolved: resolved, started_at: new Date(), endpoint: '/v1/chat/completions', request_status: 'SUCCESS' }, { model: 'provider-resolved-model', input_tokens: 1, output_tokens: 2, total_tokens: 3 });
    assert.equal(event.requestedModel, requested ?? null);
    assert.equal(event.requestedProvider_id, requested ? 7 : null);
    assert.equal(event.provider_id, 8);
    assert.equal(event.model, resolved ?? requested ?? null);
  }
});

test('only potentially consuming upstream requests require a usage event', async () => {
  for (const [expected, status, result] of [[true, 200, true], [true, 500, true], [true, undefined, true], [true, 401, false], [true, 429, false], [false, 200, false]]) {
    let actual;
    const tx = { query: async (sql, params) => {
      if (sql.startsWith('UPDATE api_requests SET usage_expected=')) actual = params[0];
      return { affectedRows: 1 };
    } };
    await finalizeRequest({ transaction: fn => fn(tx) }, { id: 1, usage_expected: expected, http_status: status, started_at: new Date(), request_status: 'FAILED' });
    assert.equal(actual, result);
  }
});
