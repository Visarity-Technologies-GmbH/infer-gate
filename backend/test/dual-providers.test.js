import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { prepareProviderRequest, executeProviderRequest } from '../src/providers/index.js';
import { encrypt } from '../src/security/credentials.js';
import { createApp } from '../src/app.js';
const config = { encryptionKey: randomBytes(32) };
const assignment = { api_type: 'OPENAI_ANTHROPIC', api_url: 'https://openai.example/v1',
  anthropic_api_url: 'https://anthropic.example/v1', encrypted_api_key: encrypt('upstream-secret', config.encryptionKey) };

test('dual OpenAI endpoints and discovery use the OpenAI base and preserve responses', async () => {
  for (const [method, url] of [['GET', '/models'], ['POST', '/chat/completions'], ['POST', '/responses'], ['POST', '/embeddings']]) {
    const req = { method, url, get: name => ({ 'content-type': 'application/json', authorization: 'Bearer pak_client' })[name] };
    const plan = prepareProviderRequest(assignment, req, Buffer.from('{"model":"any-name","stream":true}'), config);
    assert.equal(String(plan.url), `https://openai.example/v1${url}`);
    assert.equal(plan.init.headers.get('authorization'), 'Bearer upstream-secret');
    assert.equal(plan.init.headers.get('x-api-key'), null);
    assert.equal(plan.init.redirect, 'manual');
    if (url === '/chat/completions') assert.equal(JSON.parse(plan.init.body).stream_options.include_usage, true);
    for (const response of [Response.json({ data: [{ id: 'any-name' }] }), new Response('data: [DONE]\n\n'), Response.json({ error: 'quota' }, { status: 429 })]) {
      assert.equal(await executeProviderRequest(plan, async () => response), response);
    }
  }
});

test('admin can save/clear dual provider URL; unsafe URLs and unknown types are rejected', async t => {
  const writes = [];
  const db = {
    async query(sql, params) {
      if (sql.startsWith('SELECT token_hash')) return [{ token_hash: 'test' }];
      if (sql.startsWith('SELECT api_type')) return [{ api_type: 'OPENAI_COMPATIBLE' }];
      if (sql.startsWith('INSERT INTO `llm_inference_providers`') || sql.startsWith('UPDATE `llm_inference_providers`')) {
        writes.push({ sql, params }); return { insertId: 1, affectedRows: 1 };
      }
      throw new Error('Unexpected database operation');
    },
    async transaction(fn) { return fn(db); },
  };
  const server = createApp(db, config).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (body, method = 'PATCH', authorized = true) => fetch(`http://127.0.0.1:${server.address().port}/admin/providers${method === 'POST' ? '' : '/1'}`, {
    method, headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer adm_test' } : {}) }, body: JSON.stringify(body),
  });
  const body = { name: 'Dual', api_type: 'OPENAI_ANTHROPIC', api_url: assignment.api_url, anthropic_api_url: assignment.anthropic_api_url };
  assert.equal((await request(body, 'POST', false)).status, 401);
  const response = await request(body, 'POST');
  assert.equal(response.status, 201);
  assert.equal((await response.json()).anthropic_api_url, assignment.anthropic_api_url);
  assert.equal((await request({ api_type: 'OPENAI_ANTHROPIC', anthropic_api_url: assignment.anthropic_api_url })).status, 204);
  assert.equal((await request({ anthropic_api_url: null })).status, 204);
  assert(writes.at(-1).params.includes(null));
  for (const anthropic_api_url of ['https://user:secret@example.com/v1', 'https://example.com/v1?secret=x', 'https://example.com/v1#x', 'file:///tmp/test']) {
    assert.equal((await request({ anthropic_api_url })).status, 400);
  }
  assert.equal((await request({ api_type: 'UNKNOWN' })).status, 400);
  assert.equal(writes.length, 3);
});
