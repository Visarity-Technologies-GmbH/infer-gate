import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { encrypt } from '../src/security/credentials.js';

test('native streams cancel upstream work and finalize tracking on disconnect or timeout', async t => {
  for (const [type, endpoint] of [['ANTHROPIC', '/v1/chat/completions'], ['GEMINI', '/v1/chat/completions'], ['ANTHROPIC', '/v1/messages'], ['AWS_BEDROCK', '/v1/messages']]) for (const reason of ['disconnect','timeout']) {
    await t.test(`${type} ${endpoint} ${reason}`, async t => {
      const encryptionKey = randomBytes(32), finalized = [], usages = [];
      let aborted = false;
      const model = type === 'AWS_BEDROCK' ? 'anthropic.claude-opus-4-7' : 'test-model';
      const db = {
        async query(sql, params) {
          if (sql.includes('FROM user_usage_limits')) return [];
          if (sql.startsWith('SELECT * FROM model_pricing')) return [];
          if (sql.startsWith('INSERT INTO api_requests')) return { insertId: 1 };
          if (sql.includes('FROM proxy_api_keys k')) return [{ id: 1, user_id: 2, role_id: 7, role_status: 'ACTIVE', model_policy_id: 8, status: 'ACTIVE', user_status: 'ACTIVE' }];
          if (sql.includes('FROM role_model_policies')) return [{ model_policy_id: 8, model_pattern: '*', policy: 'ALLOW' }];
          if (sql.includes('FROM role_upstream_assignments')) return [{ upstream_api_key_id: 3, provider_id: 4, key_status: 'ACTIVE', provider_status: 'ACTIVE', api_type: type, aws_region: 'us-east-1', api_url: 'https://mock.example/v1', encrypted_api_key: encrypt('native-test-key', encryptionKey) }];
          if (sql.includes('completed_at=')) finalized.push(params);
          if (sql.startsWith('INSERT INTO usage_events')) usages.push(params);
          return { affectedRows: 1 };
        },
        async transaction(fn) { return fn(db); }
      };
      const config = { encryptionKey, bootstrapToken: 'test-bootstrap', modelDefault: 'DENY', bodyLimit: 10000, timeout: reason === 'timeout' ? 100 : 5000 };
      // Model discovery runs before forwarding; answer it in each provider's catalogue format.
      const catalogue = type === 'GEMINI' ? { models: [{ name: `models/${model}` }] } : { data: [{ id: model }] };
      const app = createApp(db, config, { log() {}, fetchImpl: async (url, init) => new URL(url).pathname.endsWith('/models') ? Response.json(catalogue) : new Response(new ReadableStream({
        start(controller) {
          const events = type !== 'GEMINI' ? [
            { type: 'message_start', message: { id: 'msg_partial', model, usage: { input_tokens: 4, output_tokens: 0 } } },
            { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }
          ] : [{ candidates: [{ content: { parts: [{ text: 'partial' }] } }], usageMetadata: { promptTokenCount: 4 } }];
          controller.enqueue(Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')));
          init.signal.addEventListener('abort', () => { aborted = true; controller.error(new Error('aborted')); }, { once: true });
        }
      }), { headers: { 'content-type': 'text/event-stream' } }) });
      const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
      t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
      const response = await fetch(`http://127.0.0.1:${server.address().port}${endpoint}`, { method: 'POST', headers: { authorization: 'Bearer pak_test', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }], stream: true }) });
      if (reason === 'disconnect') {
        const reader = response.body.getReader(); assert(!(await reader.read()).done); await reader.cancel();
      } else await assert.rejects(response.text());
      for (let i = 0; i < 100 && !finalized.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert(aborted); assert.equal(finalized.length, 1);
      assert.equal(finalized[0][10], reason === 'disconnect' ? 'CANCELLED' : 'FAILED');
      assert.equal(finalized[0][13], reason === 'disconnect' ? 'client_disconnected' : 'upstream_timeout');
      assert.equal(usages.length, 1); assert.equal(usages[0][6], 4);
    });
  }
});
