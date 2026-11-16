import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { digest, token, hashPassword, verifyPassword, encrypt, decrypt } from '../src/security/credentials.js';
import { modelAllowed } from '../src/services/model-policy.js';
import { extractUsage, UsageCollector } from '../src/services/usage.js';
import { authenticate, authorize, route } from '../src/services/routing.js';
import { upstreamUrl, requestHeaders } from '../src/providers/openai-compatible.js';
test('credentials are random, hashed, password verified and authenticated encryption detects tampering', async () => {
  const a = token('pak_'), b = token('pak_'); assert.notEqual(a, b); assert.equal(digest(a).length, 64);
  const hash = await hashPassword('test-password-123'); assert(!hash.includes('test-password')); assert(await verifyPassword('test-password-123', hash)); assert(!await verifyPassword('wrong', hash));
  const key = randomBytes(32), sealed = encrypt('upstream-secret', key); assert.equal(decrypt(sealed, key), 'upstream-secret');
  assert.throws(() => decrypt(sealed, randomBytes(32)));
  const parts = sealed.split('.'); parts[2] = Buffer.from('tampered').toString('base64'); assert.throws(() => decrypt(parts.join('.'), key));
});
test('exact deny, exact allow, wildcard deny and default precedence', () => {
  const policies = [{ model_pattern: '*', policy: 'DENY' }, { model_pattern: 'a', policy: 'ALLOW' }];
  assert(modelAllowed('a', policies)); assert(!modelAllowed('b', policies));
  assert(!modelAllowed('a', [...policies, { model_pattern: 'a', policy: 'DENY' }]));
  assert(!modelAllowed('A', policies)); assert(!modelAllowed('a', [])); assert(modelAllowed('a', [], 'ALLOW'));
});
test('proxy authentication and suspension/revocation are separate from routing', async () => {
  await assert.rejects(authenticate({ query: async () => [] }, 'Bearer adm_wrong'), { code: 'invalid_api_key' });
  await assert.rejects(authenticate({ query: async () => [] }, 'Bearer pak_wrong'), { code: 'invalid_api_key' });
  assert.throws(() => authorize({ status: 'REVOKED', user_status: 'ACTIVE' }), { code: 'revoked_api_key' });
  assert.throws(() => authorize({ status: 'ACTIVE', user_status: 'SUSPENDED' }), { code: 'user_suspended' });
  await assert.rejects(route({ query: async () => [] }, 1), { code: 'missing_upstream_assignment' });
  await assert.rejects(route({ query: async () => [{ key_status: 'DISABLED' }] }, 1), { code: 'upstream_key_disabled' });
  await assert.rejects(route({ query: async () => [{ key_status: 'ACTIVE', provider_status: 'DISABLED' }] }, 1), { code: 'provider_disabled' });
});
test('upstream URLs remain beneath trusted base and authorization is replaced', () => {
  assert.equal(upstreamUrl('https://example.com/v1', '/responses?x=1').href, 'https://example.com/v1/responses?x=1');
  for (const path of ['/../secret', '/%2e%2e/secret', '/%2fsecret', '/%252e%252e/secret', '/\\evil']) assert.throws(() => upstreamUrl('https://example.com/v1', path));
  const input = { authorization: 'Bearer pak_secret', connection: 'accept', accept: 'bad', 'content-type': 'application/json', cookie: 'private' };
  const headers = requestHeaders({ get: name => input[name] }, 'upstream');
  assert.equal(headers.get('authorization'), 'Bearer upstream'); assert.equal(headers.get('cookie'), null); assert.equal(headers.get('accept'), null);
});
test('usage distinguishes zero from unknown and never invents totals', () => {
  assert.deepEqual(extractUsage({ model: 'a', usage: { prompt_tokens: 0, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 0 } } }), { model: 'a', input_tokens: 0, output_tokens: 7, cached_input_tokens: null, cache_write_input_tokens: null, reasoning_tokens: 0, total_tokens: null });
  assert.equal(extractUsage({}), null);
});
test('SSE usage survives arbitrary UTF-8/chunk boundaries without buffering full streams', () => {
  const collector = new UsageCollector('text/event-stream');
  const stream = 'data: {"text":"ü"}\r\n\r\ndata: {"response":{"model":"a","usage":{"input_tokens":3,"total_tokens":5}},"type":"response.completed"}\r\n\r\ndata: [DONE]\n\n';
  for (const byte of Buffer.from(stream)) collector.push(Buffer.from([byte]));
  collector.finish(); assert.equal(collector.usage.input_tokens, 3); assert.equal(collector.usage.total_tokens, 5); assert(collector.terminal);
  const bounded = new UsageCollector('text/event-stream', 100);
  bounded.push(Buffer.from('data: '+ 'x'.repeat(10000) + '\n\n')); bounded.push(Buffer.from('data: {"usage":{"total_tokens":2}}\n\ndata: [DONE]\n\n'));
  assert.equal(bounded.usage.total_tokens, 2); assert(bounded.buffer.length <= 100);
});
