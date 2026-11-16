import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { encrypt, decrypt, digest } from '../src/security/credentials.js';
import { resolveUpstreamCredential } from '../src/security/upstream-credential.js';

test('administrator can replace upstream credentials securely without changing assignments', async t => {
  const encryptionKey = randomBytes(32);
  const key = { id: '1', name: 'Original', status: 'ACTIVE', encrypted_api_key: encrypt('old-test-key', encryptionKey), key_fingerprint: digest('old-test-key').slice(0, 16) };
  let updates = 0;
  const db = {
    async query(sql, params) {
      if (sql.startsWith('SELECT token_hash')) return [{ token_hash: 'session-test' }];
      if (sql.startsWith('SELECT k.id,p.api_type')) return params[0] === '1' ? [{ id: '1', api_type: 'OPENAI' }] : [];
      if (sql.startsWith('UPDATE upstream_api_keys SET')) {
        assert(!params.includes('new-test-key'));
        const columns = sql.slice(sql.indexOf(' SET ') + 5, sql.indexOf(',updated_at')).split(',').map(field => field.split('=')[0]);
        columns.forEach((column, i) => { key[column] = params[i]; });
        updates++;
        return { affectedRows: 1 };
      }
      if (sql.startsWith('SELECT id,provider_id,name,key_fingerprint')) {
        return [{ id: key.id, name: key.name, status: key.status, key_fingerprint: key.key_fingerprint }];
      }
      throw new Error('Unexpected database operation');
    },
    async transaction(fn) { return fn(db); },
  };
  const server = createApp(db, { encryptionKey }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (body, authorized = true, id = '1') => fetch(`http://127.0.0.1:${server.address().port}/admin/upstream-keys/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer adm_test' } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await request({ api_key: 'new-test-key' }, false)).status, 401);
  assert.equal(updates, 0);
  const response = await request({ api_key: 'new-test-key' });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(decrypt(key.encrypted_api_key, encryptionKey), 'new-test-key');
  assert.equal(key.key_fingerprint, digest('new-test-key').slice(0, 16));
  assert.equal(key.name, 'Original');
  const sealed = key.encrypted_api_key;
  assert.equal((await request({ name: 'Renamed' })).status, 204);
  assert.equal(key.encrypted_api_key, sealed);
  for (const api_key of ['', ' ', null, 123, 'bad\nkey', '$BAD-REFERENCE', 'x'.repeat(8193)]) {
    assert.equal((await request({ api_key })).status, 400);
    assert.equal(key.encrypted_api_key, sealed);
  }
  assert.equal((await request({ api_key: 'new-test-key' }, true, '999')).status, 404);
  assert.equal(updates, 2);
  const listed = await fetch(`http://127.0.0.1:${server.address().port}/admin/upstream-keys`, { headers: { authorization: 'Bearer adm_test' } });
  const listing = await listed.text();
  assert(!listing.includes('new-test-key'));
  assert(!listing.includes(sealed));
  assert.equal((await request({ api_key: '$ROTATED_TEST_KEY' })).status, 204);
  assert.equal(resolveUpstreamCredential(key.encrypted_api_key, encryptionKey, { ROTATED_TEST_KEY: 'resolved-test-key' }), 'resolved-test-key');
});
