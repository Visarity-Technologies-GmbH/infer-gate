import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { ANTHROPIC_PRICING_URL, fetchAnthropicPricing, parseAnthropicPricing } from '../src/services/anthropic-pricing.js';

const page = readFileSync(new URL('./fixtures/anthropic-pricing.html', import.meta.url), 'utf8');

test('scrapes standard model prices including collapsed rows and duration-specific cache writes', () => {
  const models = parseAnthropicPricing(page);
  assert.equal(models.length, 20);
  assert.ok(models.every(row => !row.model.includes('.')));
  assert.deepEqual(models[0], {
    model: 'claude-fable-5-1',
    pricing: { input: 10, output: 50, cache_read: 0.25, cache_write: null, cache_write_5m: 12.5, cache_write_1h: 20 },
  });
  assert.equal(models.find(row => row.model === 'claude-haiku-5-5').pricing.input, 0.1);
  assert.equal(models.find(row => row.model === 'claude-opus-4-1').pricing.input, 15);
  assert.equal(new Set(models.map(row => row.model)).size, models.length);
});

test('supports HTML entities and explicitly unavailable cache rates without inferring prices', () => {
  const models = parseAnthropicPricing(page.replace('$10', '&#36;10').replace('$12.50', '&mdash;'));
  assert.equal(models[0].pricing.input, 10);
  assert.equal(models[0].pricing.cache_write_5m, null);
});

test('rejects missing tables, changed columns and malformed rates instead of returning misleading data', () => {
  for (const html of ['', page.replace('id="model-pricing"', 'id="batch-pricing"'), page.replace('5m writes', 'Changed column'), page.replace('$10', 'Contact sales')]) {
    assert.throws(() => parseAnthropicPricing(html), { status: 502, code: 'invalid_anthropic_pricing' });
  }
});

test('fetches only the fixed public page with a timeout and redirects disabled', async () => {
  const models = await fetchAnthropicPricing(async (url, options) => {
    assert.equal(url, ANTHROPIC_PRICING_URL);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.accept, 'text/html');
    return new Response(page);
  });
  assert.equal(models.length, 20);
});

test('bounds downloads and sanitizes upstream HTTP, network and timeout errors', async () => {
  for (const fetchImpl of [
    async () => new Response('private upstream details', { status: 503 }),
    async () => { throw new Error('private upstream details'); },
    async () => { throw new DOMException('private upstream details', 'TimeoutError'); },
  ]) {
    await assert.rejects(fetchAnthropicPricing(fetchImpl), error => error.status === 502 && error.code === 'anthropic_pricing_fetch_failed' && !error.message.includes('private'));
  }
  await assert.rejects(fetchAnthropicPricing(async () => new Response('x'.repeat(5 * 1024 * 1024 + 1))), { status: 502, code: 'invalid_anthropic_pricing' });
});

test('administrator route returns the requested array, requires authentication and never changes stored prices', async t => {
  let downloads = 0;
  const db = { query: async sql => {
    assert.match(sql, /^SELECT token_hash FROM admin_sessions /);
    return [{ token_hash: 'test-session' }];
  } };
  const server = createApp(db, {}, { anthropicPricingFetchImpl: async () => { downloads++; return new Response(page); } }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/admin/pricing/anthropic`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(downloads, 0);
  const response = await fetch(url, { headers: { authorization: 'Bearer adm_test' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), parseAnthropicPricing(page));
  assert.equal(downloads, 1);
});
