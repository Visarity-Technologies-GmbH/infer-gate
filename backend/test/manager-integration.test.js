import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { database } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { digest, verifyPassword } from '../src/security/credentials.js';

const enabled = process.env.TEST_DB_NAME?.startsWith('infergate_test_');
test('real MySQL manager lifecycle, organization access, first password change and session revocation', { skip: !enabled }, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD,
    database: process.env.TEST_DB_NAME, timezone: 'Z' });
  const admin = `adm_manager_${randomBytes(12).toString('hex')}`;
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 1 HOUR))', [digest(admin)]);
  let server;
  const start = async () => {
    server = createApp(db, { encryptionKey: randomBytes(32) }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
  };
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  await start();
  t.after(async () => { await stop(); await db.close(); });
  const call = (path, method = 'GET', body, auth = admin) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = async response => { assert(response.ok, `${response.status}: ${await response.clone().text()}`); return response.json(); };
  const user = await json(await call('/admin/users', 'POST', { name: 'Manager lifecycle', email: 'manager-lifecycle@example.test' }));
  const managerPath = `/admin/users/${user.id}/manager`;
  assert.equal((await call('/manager/login', 'POST', { email: user.email, password: 'unassigned-password' }, '')).status, 401);
  assert.equal((await call(managerPath, 'PUT', { enabled: true, extra: true })).status, 400);
  const promoted = await json(await call(managerPath, 'PUT', { enabled: true }));
  assert.equal(promoted.temporary_password.length, 43);
  let [stored] = await db.query('SELECT * FROM users WHERE id=?', [user.id]);
  assert.equal(stored.is_manager, 1);
  assert(await verifyPassword(promoted.temporary_password, stored.password_hash));
  assert.notEqual(stored.password_hash, promoted.temporary_password);
  assert(Math.abs(new Date(promoted.expires_at).getTime() - Date.now() - 86400000) < 10000);
  assert.equal((await call(managerPath, 'PUT', { enabled: true })).status, 409);
  const login = password => call('/manager/login', 'POST', { email: user.email, password }, '');
  const initial = await json(await login(promoted.temporary_password));
  assert(initial.password_change_required);
  assert.equal((await call('/manager/users', 'GET', undefined, initial.token)).status, 403);
  assert.equal((await call('/admin/users', 'GET', undefined, initial.token)).status, 401);
  assert.equal((await call('/manager/password', 'PUT', { current_password: promoted.temporary_password, password: 'short' }, initial.token)).status, 400);
  const permanentPassword = 'manager-permanent-test-password';
  assert.equal((await call('/manager/password', 'PUT', { current_password: promoted.temporary_password, password: permanentPassword }, initial.token)).status, 204);
  assert.equal((await call('/manager/session', 'GET', undefined, initial.token)).status, 401);
  const manager = await json(await login(permanentPassword));
  assert.equal(manager.password_change_required, false);
  const managed = (path, method = 'GET', body) => call(`/manager${path}`, method, body, manager.token);
  const other = await json(await managed('/users', 'POST', { name: 'Created by manager', email: 'manager-created@example.test' }));
  const group = await json(await managed('/groups', 'POST', { name: 'Manager-created group' }));
  assert.equal((await managed(`/users/${other.id}`, 'PATCH', { name: 'Edited by manager' })).status, 204);
  assert.equal((await managed(`/groups/${group.id}`, 'PATCH', { description: 'Edited by manager' })).status, 204);
  assert.equal((await managed(`/groups/${group.id}/users/${other.id}`, 'PUT')).status, 204);
  assert.equal((await json(await managed(`/groups/${group.id}/users`))).data[0].id, other.id);
  assert.equal((await managed(`/groups/${group.id}/users/${other.id}`, 'DELETE')).status, 204);
  const key = await json(await managed('/proxy-keys', 'POST', { name: 'Created by manager', user_id: other.id }));
  const policy = await json(await call('/admin/model-policies', 'POST', { name: 'Manager assignment test', rules: [] }));
  const role = await json(await call('/admin/roles', 'POST', { name: 'Manager assignment test', model_policy_id: policy.id }));
  assert.equal((await managed(`/proxy-keys/${key.id}/role`, 'PUT', { role_id: role.id })).status, 204);
  assert.equal((await call(`/admin/roles/${role.id}`, 'PUT', { name: 'Disabled manager test', model_policy_id: policy.id, status: 'DISABLED' })).status, 204);
  assert.equal((await managed(`/proxy-keys/${key.id}/role`, 'PUT', { role_id: role.id })).status, 409);
  assert.equal((await managed(`/proxy-keys/${key.id}/role`, 'PUT', { role_id: null })).status, 204);
  assert.equal((await managed(`/proxy-keys/${key.id}/revoke`, 'POST')).status, 204);
  assert.equal((await managed(`/users/${other.id}/usage-limit`, 'PUT', { enabled: true, period: 'DAILY', basis: 'TOKENS', amount: '5' })).status, 204);
  const viewing = await json(await managed(`/users/${other.id}/viewing-key`, 'POST', {}));
  assert.equal((await call('/user/usage', 'GET', undefined, viewing.key)).status, 200);
  assert.equal((await managed(`/users/${other.id}`, 'PATCH', { status: 'SUSPENDED' })).status, 204);
  assert.equal((await call('/user/usage', 'GET', undefined, viewing.key)).status, 401);
  assert.equal((await managed(`/users/${other.id}`, 'PATCH', { status: 'ACTIVE' })).status, 204);
  const replacement = await json(await managed(`/users/${other.id}/viewing-key`, 'POST', {}));
  assert.notEqual(replacement.key, viewing.key);
  assert.equal((await call('/user/usage', 'GET', undefined, viewing.key)).status, 401);
  for (const path of ['/dashboard', '/usage', '/requests', '/usage/categories', '/usage/models', '/users', '/groups', '/proxy-keys'])
    assert.equal((await managed(path)).status, 200, path);
  for (const [method, path, body] of [['PUT', `/users/${other.id}/manager`, { enabled: true }],
    ['PATCH', `/users/${other.id}`, { is_manager: true }], ['POST', '/users', { name: 'Escalated', email: 'no@example.test', is_manager: true }],
    ['GET', '/settings/debug-logging'], ['GET', '/pricing'], ['POST', '/roles', {}], ['POST', '/providers', {}]])
    assert.equal((await managed(path, method, body)).status, method === 'PATCH' || path === '/users' ? 400 : 403, path);
  const safeUser = await json(await managed(`/users/${user.id}`));
  assert.doesNotMatch(JSON.stringify(safeUser), /password|auth_version/);
  const reset = await json(await call(managerPath, 'PUT', { enabled: true, reset_password: true }));
  assert.equal((await managed('/session')).status, 401);
  assert.equal((await login(permanentPassword)).status, 401);
  const beforeSuspension = await json(await login(reset.temporary_password));
  assert.equal((await call(`/admin/users/${user.id}`, 'PATCH', { status: 'SUSPENDED' })).status, 204);
  assert.equal((await call(`/admin/users/${user.id}`, 'PATCH', { status: 'ACTIVE' })).status, 204);
  assert.equal((await call('/manager/session', 'GET', undefined, beforeSuspension.token)).status, 401);
  const beforeDemotion = await json(await login(reset.temporary_password));
  assert.equal((await call(managerPath, 'PUT', { enabled: false })).status, 204);
  assert.equal((await call('/manager/session', 'GET', undefined, beforeDemotion.token)).status, 401);
  assert.equal((await login(reset.temporary_password)).status, 401);
  const final = await json(await call(managerPath, 'PUT', { enabled: true }));
  await db.query('UPDATE users SET manager_password_expires_at=DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE id=?', [user.id]);
  assert.equal((await login(final.temporary_password)).status, 401);
  // Exhaustion is tested explicitly; restart the app's in-memory limiter afterward.
  for (let index = 0; index < 11; index++) await login('wrong-password');
  assert.equal((await login('wrong-password')).status, 429);
  await stop(); await start();
  const refreshed = await json(await call(managerPath, 'PUT', { enabled: true, reset_password: true }));
  const logoutSession = await json(await login(refreshed.temporary_password));
  assert.equal((await call('/manager/logout', 'POST', undefined, logoutSession.token)).status, 204);
  assert.equal((await call('/manager/session', 'GET', undefined, logoutSession.token)).status, 401);
});
