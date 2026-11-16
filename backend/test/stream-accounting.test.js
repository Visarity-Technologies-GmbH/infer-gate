import test from 'node:test';
import assert from 'node:assert/strict';
import { accountingBody } from '../src/providers/openai-compatible.js';

test('stream accounting preserves request fields and other stream options', () => {
  const input = { model: 'resolved-model', messages: [{ role: 'user', content: 'Hello' }], stream: true, temperature: 0.3, stream_options: { include_usage: false, vendor_option: true } };
  const body = Buffer.from(JSON.stringify(input));
  const req = { method: 'POST', url: '/chat/completions/?test=1', get: () => 'application/json' };
  assert.deepEqual(JSON.parse(accountingBody(req, body)), { ...input, stream_options: { include_usage: true, vendor_option: true } });
  assert.deepEqual(JSON.parse(body), input);
});

test('stream accounting leaves other endpoints, non-streaming bodies and invalid options unchanged', () => {
  const req = { method: 'POST', url: '/chat/completions', get: () => 'application/json' };
  for (const stream_options of [null, [], 'invalid', false]) {
    const body = Buffer.from(JSON.stringify({ stream: true, stream_options }));
    assert.equal(accountingBody(req, body), body);
  }
  const body = Buffer.from('{ "model": "test-model", "stream": false }');
  assert.equal(accountingBody(req, body), body);
  for (const other of [{ url: '/responses' }, { method: 'GET' }, { get: () => 'application/octet-stream' }]) {
    const raw = Buffer.from('unparsed');
    assert.equal(accountingBody({ ...req, ...other }, raw), raw);
  }
});
