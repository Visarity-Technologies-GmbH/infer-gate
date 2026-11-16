import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { encrypt } from '../src/security/credentials.js';
import { validateUpstreamCredential, resolveUpstreamCredential } from '../src/security/upstream-credential.js';
import { prepareProviderRequest } from '../src/providers/index.js';

const encryptionKey = randomBytes(32);
test('upstream credentials accept literals and strict environment references', () => {
  for (const value of ['literal-secret', '$OPENAIKEY', '$_KEY_2']) assert.equal(validateUpstreamCredential(value), value);
  for (const value of ['$', '$2KEY', '${KEY}', '$KEY suffix', '$KEY\n', '', null]) assert.throws(() => validateUpstreamCredential(value));
});
test('environment resolution fails closed, hides names and values, and never recursively expands', () => {
  const stored = encrypt('$SECRET_NAME', encryptionKey);
  for (const env of [{}, {SECRET_NAME:''}, {SECRET_NAME:'  '}, {SECRET_NAME:'secret\r\nheader'}, Object.create({SECRET_NAME:'inherited'})]) {
    assert.throws(() => resolveUpstreamCredential(stored, encryptionKey, env), error => {
      assert.equal(error.status, 503); assert.equal(error.code, 'upstream_credential_unavailable');
      assert.doesNotMatch(error.message, /SECRET_NAME|secret\r/); return true;
    });
  }
  const env = {SECRET_NAME:'first'};
  assert.equal(resolveUpstreamCredential(stored, encryptionKey, env), 'first');
  env.SECRET_NAME = '$OTHER';
  assert.equal(resolveUpstreamCredential(stored, encryptionKey, env), '$OTHER');
  assert.equal(resolveUpstreamCredential(encrypt('literal', encryptionKey), encryptionKey, {}), 'literal');
});
test('all providers resolve environment credentials for model discovery and streaming chat', t => {
  const name = 'INFERGATE_TEST_UPSTREAM_CREDENTIAL';
  const previous = process.env[name];
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  process.env[name] = 'test-environment-secret';
  for (const api_type of ['OPENAI_COMPATIBLE','ANTHROPIC','GEMINI','AWS_BEDROCK']) {
    const assignment = {api_type, api_url:'https://provider.example/v1', aws_region:'eu-central-1', encrypted_api_key:encrypt('$'+name,encryptionKey)};
    for (const method of ['GET','POST']) {
      const req = {method, url:method === 'GET' ? '/models' : '/chat/completions', get: name => ({ 'content-type':'application/json', authorization:'Bearer pak_client' })[name]};
      const body = Buffer.from(JSON.stringify({model:'test-model',messages:[{role:'user',content:'test'}],stream:true}));
      const plan = prepareProviderRequest(assignment,req,body,{encryptionKey});
      const header = api_type === 'ANTHROPIC' ? 'x-api-key' : api_type === 'GEMINI' ? 'x-goog-api-key' : 'authorization';
      assert.equal(plan.init.headers.get(header), header === 'authorization' ? 'Bearer test-environment-secret' : 'test-environment-secret');
      assert.doesNotMatch(JSON.stringify([...plan.init.headers]), /pak_client|INFERGATE_TEST/);
    }
  }
});
