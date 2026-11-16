import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../src/app.js';
import { decrypt, digest } from '../src/security/credentials.js';
import { DEFAULT_CLASSIFICATION_TEMPLATE } from '../src/routes/classification-handlers.js';

test('classification handlers require administrator access, validate JSON and protect credentials', async t => {
  const encryptionKey = randomBytes(32), records = [];
  let writes = 0;
  const db = {
    async query(sql, params) {
      if (sql.startsWith('SELECT token_hash')) return params[0] === digest('adm_test') ? [{ token_hash: params[0] }] : [];
      if (sql.startsWith('INSERT INTO classification_handlers')) {
        writes++;
        const [name, description, api_url, encrypted_api_key, key_fingerprint, json_template, maxToken] = params;
        assert(!params.includes('test-classifier-secret'));
        records.push({ id: String(records.length + 1), name, description, api_url, encrypted_api_key, key_fingerprint, json_template, maxToken });
        return { insertId: records.at(-1).id };
      }
      if (sql.startsWith('SELECT id,name,description,api_url,key_fingerprint')) {
        assert(!sql.includes('encrypted_api_key'));
        return records.filter(row => Number(row.id) > Number(params[0])).slice(0, 500).map(({ encrypted_api_key, ...safe }) => safe);
      }
      if (sql.startsWith('UPDATE classification_handlers SET')) {
        const row = records.find(row => row.id === params.at(-1));
        if (!row) return { affectedRows: 0 };
        writes++;
        const columns = sql.slice(sql.indexOf(' SET ') + 5, sql.indexOf(',updated_at')).split(',').map(field => field.split('=')[0]);
        columns.forEach((column, i) => { row[column] = params[i]; });
        return { affectedRows: 1 };
      }
      throw new Error('Unexpected database operation');
    },
  };
  const server = createApp(db, { encryptionKey }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (method = 'GET', body, credential = 'adm_test', suffix = '') => fetch(`http://127.0.0.1:${server.address().port}/admin/classification-handlers${suffix}`, {
    method, headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const input = { name: 'Security classification', description: 'Classifies prompts', api_url: 'https://classifier.example.com/classify', api_key: 'test-classifier-secret' };
  for (const credential of [null, 'pak_test', 'adm_invalid']) {
    assert.equal((await call('GET', undefined, credential)).status, 401);
    assert.equal((await call('POST', input, credential)).status, 401);
    assert.equal((await call('PATCH', { name: 'Unauthorized' }, credential, '/1')).status, 401);
  }
  assert.equal(writes, 0);
  const created = await call('POST', input);
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.deepEqual(JSON.parse(result.json_template), { prompt: '${PROMPT}' });
  assert.equal(result.json_template, DEFAULT_CLASSIFICATION_TEMPLATE);
  assert.equal(result.maxToken, null);
  assert.equal(result.key_fingerprint, digest(input.api_key).slice(0, 16));
  assert(!JSON.stringify(result).includes(input.api_key));
  assert.equal(result.encrypted_api_key, undefined);
  assert.equal(decrypt(records[0].encrypted_api_key, encryptionKey), input.api_key);
  const sealed = records[0].encrypted_api_key;

  for (const json_template of ['', '{ prompt: "${PROMPT}" }', '{"prompt": "${PROMPT}",}', 'undefined', '{', {}, null, 12, ' '.repeat(32769)]) {
    const response = await call('POST', { ...input, json_template });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'invalid_json_template');
    assert.equal((await call('PATCH', { json_template }, 'adm_test', '/1')).status, 400);
  }
  for (const change of [
    ...[0, -1, 1.5, '30000', 4294967296, true].map(maxToken => ({ maxToken })),
    { name: '' }, { name: 'x'.repeat(256) }, { description: 123 }, { description: 'x'.repeat(10001) },
    { api_url: 'invalid' }, { api_url: 'file:///tmp/classifier' }, { api_url: 'https://user:secret@example.com' }, { api_url: 'https://example.com/#fragment' },
    { api_key: '' }, { api_key: null }, { api_key: 'bad\nkey' }, { api_key: 'x'.repeat(8193) },
    { encrypted_api_key: 'injected' }, { constructor: 'injected' },
  ]) assert.equal((await call('POST', { ...input, ...change })).status, 400);
  assert.equal(writes, 1);
  assert.equal((await call('PATCH', {}, 'adm_test', '/1')).status, 400);
  assert.equal((await call('PATCH', { name: 'Missing' }, 'adm_test', '/999')).status, 404);
  assert.equal((await call('PATCH', { name: 'Invalid' }, 'adm_test', '/bad')).status, 400);

  assert.equal((await call('PATCH', { maxToken: 12000 }, 'adm_test', '/1')).status, 204);
  assert.equal(records[0].maxToken, 12000);
  assert.equal((await call('PATCH', { maxToken: null }, 'adm_test', '/1')).status, 204);
  assert.equal(records[0].maxToken, null);

  const custom = '{"text":"${PROMPT}","options":{"labels":["safe","sensitive"]}}';
  assert.equal((await call('PATCH', { name: 'Renamed', json_template: custom }, 'adm_test', '/1')).status, 204);
  assert.equal(records[0].json_template, custom);
  assert.equal(records[0].encrypted_api_key, sealed);
  assert.equal((await call('PATCH', { api_key: 'rotated-test-secret' }, 'adm_test', '/1')).status, 204);
  assert.equal(decrypt(records[0].encrypted_api_key, encryptionKey), 'rotated-test-secret');
  const listed = await (await call()).json();
  assert.equal(listed.data[0].name, 'Renamed');
  assert.equal(listed.data[0].json_template, custom);
  assert.equal(listed.next_after, null);
  assert(!JSON.stringify(listed).includes('rotated-test-secret'));
  assert(!JSON.stringify(listed).includes(records[0].encrypted_api_key));
  assert.equal((await (await call('GET', undefined, 'adm_test', '?after=1')).json()).data.length, 0);
  assert.equal((await call('GET', undefined, 'adm_test', '?after=bad')).status, 400);
  // Any syntactically valid JSON is accepted, without inventing a payload schema.
  for (const json_template of [custom, 'null', '[]', '"${PROMPT}"', 'false', '123']) {
    assert.equal((await call('POST', { ...input, json_template })).status, 201);
  }
});
