import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { managerPermissions } from '../src/routes/manager.js';
import { digest } from '../src/security/credentials.js';

test('manager permissions allow only explicit resource/report operations and deny infrastructure and promotion', () => {
  for (const [method, path] of [
    ['GET', '/dashboard'], ['GET', '/usage/categories'], ['GET', '/requests'], ['GET', '/users/2'],
    ['POST', '/users'], ['PATCH', '/users/2'], ['POST', '/groups'], ['PATCH', '/groups/2'],
    ['PUT', '/groups/2/users/3'], ['DELETE', '/groups/2/users/3'], ['POST', '/proxy-keys'],
    ['POST', '/proxy-keys/2/revoke'], ['PUT', '/proxy-keys/2/role'], ['GET', '/roles'],
    ['PUT', '/users/2/usage-limit'], ['POST', '/users/2/viewing-key'],
  ]) {
    let allowed = false;
    managerPermissions({ method, path, manager: {} }, {}, () => { allowed = true; });
    assert(allowed, `${method} ${path}`);
  }
  for (const [method, path] of [
    ['PUT', '/users/2/manager'], ['POST', '/roles'], ['GET', '/roles/2'], ['PUT', '/roles/2/assignments'],
    ['GET', '/settings/debug-logging'], ['GET', '/pricing'], ['POST', '/providers'],
    ['GET', '/providers/2'], ['POST', '/upstream-keys/2/check'], ['GET', '/model-policies'],
    ['GET', '/classification-handlers'], ['GET', '/future-route'], ['DELETE', '/users/2'],
    ['GET', '/users/2%2Fmanager'], ['PUT', '/Users/2/Manager/'],
  ]) assert.throws(() => managerPermissions({ method, path, manager: {} }, {}, () => {}), { status: 403 }, `${method} ${path}`);
  assert.throws(() => managerPermissions({ method: 'GET', path: '/users' }, {}, () => {}), { status: 403 });
});

test('manager API separates credentials, sanitizes lookups, denies hidden APIs, and restricts temporary sessions', async t => {
  const credential = `mgr_${'a'.repeat(43)}`;
  let temporary = false;
  const queries = [];
  const db = { query: async (sql, params) => {
    queries.push(sql);
    if (sql.includes('FROM manager_sessions s')) return params[0] === digest(credential)
      ? [{ id: 1, name: 'Manager', email: 'manager@example.test', manager_password_temporary: temporary }] : [];
    if (sql.includes('FROM admin_sessions')) return [];
    if (sql.includes("FROM roles WHERE status='ACTIVE'")) return [{ id: 2, name: 'Role', status: 'ACTIVE' }];
    if (sql.includes('FROM `llm_inference_providers`') || sql.includes('FROM `upstream_api_keys`')) {
      assert.match(sql, /^SELECT id,name FROM/); return [{ id: 1, name: 'Report label' }];
    }
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const call = (path, method = 'GET', auth = credential) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { authorization: `Bearer ${auth}` },
  });
  for (const auth of ['adm_test', 'pak_test', 'uvk_test', `mgr_${'b'.repeat(43)}`])
    assert.equal((await call('/manager/users', 'GET', auth)).status, 401);
  assert.equal((await call('/admin/users')).status, 401);
  for (const path of ['/manager/providers', '/manager/upstream-keys', '/manager/roles']) {
    const response = await call(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(JSON.stringify(await response.json()), /password|api_url|fingerprint|evaluation_script/);
  }
  for (const [method, path] of [['GET', '/manager/settings/debug-logging'], ['PUT', '/manager/users/2/manager'],
    ['GET', '/manager/roles/2'], ['POST', '/manager/upstream-keys/2/check']]) {
    queries.length = 0;
    assert.equal((await call(path, method)).status, 403);
    assert.equal(queries.length, 1); // Authentication only; no resource query executes.
  }
  temporary = true;
  assert.equal((await call('/manager/roles')).status, 403);
  const session = await call('/manager/session');
  assert.equal(session.status, 200);
  assert.equal((await session.json()).password_change_required, true);
});
