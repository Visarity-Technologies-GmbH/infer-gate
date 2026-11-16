import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { createApp } from '../src/app.js';
import { digest } from '../src/security/credentials.js';
import { DEFAULT_EVALUATION_SCRIPT, validateEvaluationScript, roleWithEvaluationScript } from '../src/services/evaluation-script.js';

test('evaluation script default matches the contract; validation compiles without executing', async () => {
  assert.equal(validateEvaluationScript(DEFAULT_EVALUATION_SCRIPT), DEFAULT_EVALUATION_SCRIPT);
  // Only run the trusted constant to check its output contract.
  const result = await new Script(`${DEFAULT_EVALUATION_SCRIPT}\nevaluate({}, {}, []).then(JSON.stringify)`).runInNewContext();
  assert.deepEqual(JSON.parse(result), { category: 'other', sensitiveData: false, complexity: 0, models: null });
  assert.equal(validateEvaluationScript(null), null);
  for (const value of ['', ' ', 12, {}, 'x'.repeat(32769), 'async function evaluate( {'])
    assert.throws(() => validateEvaluationScript(value), { status: 400, code: 'invalid_evaluation_script' });
  const script = 'throw new Error("must not execute");\nasync function evaluate() { return {}; }';
  assert.equal(validateEvaluationScript(script), script);
  assert.equal(validateEvaluationScript('while (true) {}'), 'while (true) {}');
  assert.equal(roleWithEvaluationScript({ classification_handler_id: 1, evaluation_script: null }).evaluation_script, DEFAULT_EVALUATION_SCRIPT);
  assert.equal(roleWithEvaluationScript({ classification_handler_id: null, evaluation_script: null }).evaluation_script, null);
});

test('admin role API saves, reads, resets and preserves scripts without executing them', async t => {
  const rows = [];
  let writes = 0;
  const db = {
    async query(sql, params = []) {
      if (sql.startsWith('SELECT token_hash')) return params[0] === digest('adm_script_test') ? [{ token_hash: params[0] }] : [];
      if (sql.startsWith('INSERT INTO roles')) {
        const [name, description, model_policy_id, status, classification_handler_id, evaluation_script] = params;
        rows.push({ id: String(rows.length + 1), name, description, model_policy_id, status, classification_handler_id, evaluation_script });
        writes++; return { insertId: rows.at(-1).id };
      }
      if (sql.startsWith('UPDATE roles SET')) {
        const row = rows.find(row => row.id === params.at(-1));
        if (!row) return { affectedRows: 0 };
        const columns = sql.slice(sql.indexOf(' SET ') + 5, sql.indexOf(',updated_at')).split(',').map(field => field.split('=')[0]);
        columns.forEach((column, i) => { row[column] = params[i]; });
        writes++; return { affectedRows: 1 };
      }
      if (sql.startsWith('SELECT r.*')) return rows;
      if (sql === 'SELECT * FROM roles WHERE id=?') return rows.filter(row => row.id === params[0]);
      throw new Error('Unexpected database operation');
    },
  };
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (path, method = 'GET', body, credential = 'adm_script_test') => fetch(`http://127.0.0.1:${server.address().port}/admin${path}`, {
    method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const input = { name: 'Script role', model_policy_id: 1, classification_handler_id: 7 };
  const custom = 'async function evaluate(input, input_type, classification, models, context) { return {category:"custom", sensitiveData:true, models:models}; }';
  for (const credential of ['pak_test', 'adm_invalid']) {
    assert.equal((await call('/role-options', 'GET', undefined, credential)).status, 401);
    assert.equal((await call('/roles', 'POST', { ...input, evaluation_script: custom }, credential)).status, 401);
    assert.equal((await call('/roles/1', 'PUT', { ...input, evaluation_script: custom }, credential)).status, 401);
  }
  assert.equal(writes, 0);
  assert.deepEqual(await (await call('/role-options')).json(), { default_evaluation_script: DEFAULT_EVALUATION_SCRIPT });
  assert.equal((await call('/roles', 'POST', input)).status, 201);
  assert.equal(rows[0].evaluation_script, DEFAULT_EVALUATION_SCRIPT);
  assert.equal((await (await call('/roles/1')).json()).evaluation_script, DEFAULT_EVALUATION_SCRIPT);
  assert.equal((await call('/roles/1', 'PUT', { ...input, evaluation_script: custom })).status, 204);
  assert.equal((await (await call('/roles')).json()).data[0].evaluation_script, custom);
  assert.equal((await call('/roles/1', 'PUT', { ...input, name: 'Renamed' })).status, 204);
  assert.equal(rows[0].evaluation_script, custom);
  assert.equal((await call('/roles/1', 'PUT', { ...input, classification_handler_id: null })).status, 204);
  assert.equal(rows[0].evaluation_script, custom);
  assert.equal((await call('/roles/1', 'PUT', input)).status, 204);
  assert.equal(rows[0].evaluation_script, custom);
  const before = writes;
  for (const evaluation_script of ['', false, 1, {}, 'async function evaluate( {', 'x'.repeat(32769)]) {
    for (const method of ['POST', 'PUT']) {
      const response = await call(method === 'POST' ? '/roles' : '/roles/1', method, { ...input, evaluation_script });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'invalid_evaluation_script');
    }
  }
  assert.equal(writes, before);
  assert.equal(rows[0].evaluation_script, custom);
  assert.equal((await call('/roles/1', 'PUT', { ...input, evaluation_script: null })).status, 204);
  assert.equal(rows[0].evaluation_script, null);
  assert.equal((await (await call('/roles/1')).json()).evaluation_script, DEFAULT_EVALUATION_SCRIPT);
  assert.equal((await call('/roles/999', 'PUT', { ...input, evaluation_script: custom })).status, 404);
  assert.equal((await call('/roles', 'POST', { ...input, name: 'Throwing script', evaluation_script: 'throw new Error("not executed")' })).status, 201);
});
