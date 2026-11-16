import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRules } from '../src/routes/model-policies.js';
import { modelAllowed } from '../src/services/model-policy.js';
test('shared policy rule validation and precedence remain deterministic', () => {
  const rules = validateRules([{ model_pattern: '*', policy: 'DENY' }, { model_pattern: 'a', policy: 'ALLOW' }, { model_pattern: 'a', policy: 'DENY' }]);
  assert(!modelAllowed('a', rules)); assert(!modelAllowed('b', rules));
  for (const invalid of [null, {}, [null], [{ model_pattern: 'x', policy: 'BAD' }], [{ model_pattern: 'x', policy: 'ALLOW' }, { model_pattern: 'x', policy: 'ALLOW' }]]) assert.throws(() => validateRules(invalid), { status: 400 });
});

test('shared policy endpoints require administrator authentication before database access', async t => {
  const { createApp } = await import('../src/app.js');
  let queries = 0;
  const server = createApp({ query: async () => { queries++; return []; } }, {}).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (const [path, method] of [['/model-policies', 'GET'], ['/model-policies', 'POST'], ['/model-policies/1', 'GET'], ['/model-policies/1', 'PUT'], ['/proxy-keys/1/model-policy', 'GET'], ['/proxy-keys/1/model-policy', 'PUT']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, { method });
    assert.equal(response.status, 401);
  }
  assert.equal(queries, 0);
});

test('wildcard families allow matching models while catch-all denies everything else', () => {
  const rules = validateRules([{ model_pattern: 'qwen*', policy: 'ALLOW' }, { model_pattern: '*', policy: 'DENY' }]);
  for (const name of ['qwen', 'qwen3', 'qwen/qwen3-32b']) assert(modelAllowed(name, rules));
  for (const name of ['Qwen3', 'other-qwen', 'gpt-5', undefined]) assert(!modelAllowed(name, rules));
  assert(!modelAllowed('qwen-private', [...rules, { model_pattern: 'qwen-private', policy: 'DENY' }]));
  assert(!modelAllowed('qwen-private-1', [...rules, { model_pattern: '*private*', policy: 'DENY' }]));
  assert(modelAllowed('qwen-private-1', [...rules, { model_pattern: '*private*', policy: 'DENY' }, { model_pattern: 'qwen-private-1', policy: 'ALLOW' }]));
});
test('wildcards match entire names, support multiple stars and treat regex characters literally', () => {
  const check = (pattern, model) => modelAllowed(model, [{ model_pattern: pattern, policy: 'ALLOW' }]);
  assert(check('*qwen*', 'vendor/qwen3'));
  assert(check('qwen*-*b', 'qwen3-32b'));
  assert(!check('qwen*-*b', 'qwen3-32b-extra'));
  assert(check('qwen**', 'qwen3'));
  assert(!check('ab*bc', 'abc'));
  assert(check('qwen.[x]*', 'qwen.[x]3'));
  assert(!check('qwen.[x]*', 'qwenax3'));
  assert(!check('**', undefined));
});
test('model discovery uses the same wildcard restrictions as inference', async () => {
  const { filterModelList } = await import('../src/services/model-list.js');
  const result = await filterModelList(Response.json({ data: [{ id: 'qwen3' }, { id: 'qwen-private' }, { id: 'gpt-5' }] }), [
    { model_pattern: 'qwen*', policy: 'ALLOW' }, { model_pattern: '*', policy: 'DENY' }, { model_pattern: 'qwen-private', policy: 'DENY' }
  ], 'DENY');
  assert.deepEqual(result.data, [{ id: 'qwen3' }]);
});
