import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import { digest, token } from '../src/security/credentials.js';

test('personal MCP tokens isolate owners, scopes, expiry and offboarding', { skip: !process.env.TEST_DB_NAME?.startsWith('infergate_test_') }, async t => {
  const db = database({ socketPath: process.env.DB_SOCKET, host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD,
    database: process.env.TEST_DB_NAME, timezone: 'Z' });
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
  const admin = token('adm_'), manager = token('mgr_');
  await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,UTC_TIMESTAMP()+INTERVAL 1 DAY)', [digest(admin)]);
  const { insertId: user } = await db.query("INSERT INTO users(name,email,is_manager) VALUES ('MCP manager','mcp-manager@example.test',TRUE)");
  await db.query('INSERT INTO manager_sessions(token_hash,user_id,auth_version,expires_at) VALUES (?,?,0,UTC_TIMESTAMP()+INTERVAL 1 DAY)', [digest(manager),user]);
  const call = (path, auth, method = 'GET', body) => fetch('http://127.0.0.1:' + server.address().port + path, {
    method, headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify(body)
  });
  const use = (path, auth) => call(path, auth, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const create = (area, auth, extra) => call('/' + area + '/mcp-tokens', auth, 'POST', { name: 'Client', valid_through: '2099-12-31', ...extra });
  const issue = async (area, auth, extra) => {
    const res = await create(area, auth, extra);
    assert.equal(res.status, 201);
    const result = await res.json();
    assert.match(result.token, /^mcp_[A-Za-z0-9_-]{43}$/);
    assert.equal(result.expires_at, '2100-01-01T00:00:00.000Z');
    return result;
  };
  assert.equal((await create('manager', manager, { scope: 'ADMIN' })).status, 403);
  assert.equal((await create('admin', admin, { valid_through: '2099-02-30' })).status, 400);
  assert.equal((await create('admin', admin, { valid_through: '2000-01-01' })).status, 400);
  const administration = await issue('admin', admin, { scope: 'ADMIN' });
  const first = await issue('manager', manager), second = await issue('manager', manager);
  assert.equal((await use('/admin/mcp', administration.token)).status, 200);
  assert.equal((await use('/report/mcp', administration.token)).status, 403);
  assert.equal((await use('/report/mcp', first.token)).status, 200);
  assert.equal((await use('/admin/mcp', first.token)).status, 403);
  assert.equal((await create('admin', administration.token)).status, 401);
  assert.equal((await call('/manager/users', first.token)).status, 401);
  const list = async (area, auth) => (await (await call('/' + area + '/mcp-tokens', auth)).json()).data;
  const rename = (area, auth, id, body) => call('/' + area + '/mcp-tokens/' + id, auth, 'PATCH', body);
  assert.equal((await rename('manager', manager, administration.id, { name: 'Other' })).status, 404);
  assert.equal((await rename('manager', manager, first.id, { name: 'My client' })).status, 204);
  assert.equal((await rename('admin', admin, first.id, { name: ' Shared client ' })).status, 204);
  assert.equal((await rename('admin', admin, first.id, { name: ' ', scope: 'ADMIN' })).status, 400);
  assert.equal((await list('manager', manager)).find(row => String(row.id) === String(first.id)).name, 'Shared client');
  assert.equal((await use('/report/mcp', first.token)).status, 200);
  const management = await issue('manager', manager, { scope: 'MANAGER' });
  const managerRpc = (auth, name, args) => call('/manager/mcp', auth, 'POST', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args }
  });
  for (const credential of [management.token, manager]) {
    const response = await use('/manager/mcp', credential);
    assert.equal(response.status, 200);
    const names = (await response.json()).result.tools.map(tool => tool.name);
    assert.equal(names.length, 18);
    assert.ok(names.includes('rename_proxy_key'));
    for (const forbidden of ['promote_to_manager', 'edit_role', 'set_role_upstreams', 'create_provider', 'list_providers']) {
      assert.ok(!names.includes(forbidden));
      assert.equal((await (await managerRpc(credential, forbidden, {})).json()).error.code, -32602);
    }
  }
  assert.equal((await use('/manager/mcp', first.token)).status, 403);
  assert.equal((await use('/admin/mcp', management.token)).status, 403);
  assert.equal((await use('/report/mcp', management.token)).status, 403);
  assert.equal((await create('manager', management.token)).status, 401);
  const unset = await (await managerRpc(manager, 'get_usage_cap', { id: user })).json();
  assert.deepEqual(JSON.parse(unset.result.content[0].text), { enabled: false });
  const configured = await (await managerRpc(manager, 'set_usage_cap', {
    id: user, enabled: true, basis: 'TOKENS', period: 'DAILY', amount: '2'
  })).json();
  assert.equal(configured.result.isError, false);
  for (const [path, auth] of [['/admin/mcp', administration.token], ['/manager/mcp', management.token]]) {
    const response = await call(path, auth, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_usage_cap', arguments: { id: user } } });
    const cap = JSON.parse((await response.json()).result.content[0].text);
    assert.equal(cap.amount, '2.000000');
    assert.equal(cap.consumed, '0.000000');
    assert.equal(cap.blocked, false);
  }
  const policy = await db.query("INSERT INTO model_policies(name) VALUES ('Manager MCP test policy')");
  const role = await db.query("INSERT INTO roles(name,model_policy_id,status) VALUES ('Manager MCP test role',?,'DISABLED')", [policy.insertId]);
  const listed = await (await managerRpc(management.token, 'list_roles', {})).json();
  const summary = JSON.parse(listed.result.content[0].text).data.find(row => row.id === role.insertId);
  assert.deepEqual(summary, { id: role.insertId, name: 'Manager MCP test role', status: 'DISABLED' });
  for (const [path, auth] of [['/admin/mcp', administration.token], ['/manager/mcp', management.token]]) {
    const response = await call(path, auth, 'POST', { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_role_models', arguments: { id: role.insertId } } });
    const { result } = await response.json();
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /role is disabled/i);
  }
  const unavailable = await (await managerRpc(management.token, 'assign_proxy_key_role', { id: 1, role_id: role.insertId })).json();
  assert.equal(unavailable.result.content[0].text, 'assign_proxy_key_role failed. Choose an active role');
  const created = await (await managerRpc(management.token, 'create_proxy_key', { user_id: user, name: 'Manager MCP key' })).json();
  const key = JSON.parse(created.result.content[0].text);
  for (const [path, credential] of [['/admin/mcp', administration.token], ['/manager/mcp', management.token]]) {
    const listKeys = async args => {
      const response = await call(path, credential, 'POST', { jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'list_proxy_keys', arguments: args } });
      const { result } = await response.json();
      assert.equal(result.isError, false);
      return JSON.parse(result.content[0].text).data;
    };
    const row = (await listKeys({})).find(row => row.id === key.id);
    assert.equal(row.key_prefix, key.key_prefix);
    assert.equal(row.api_key, undefined);
    assert.equal(row.key_hash, undefined);
    assert.ok((await listKeys({ after: key.id })).every(row => BigInt(row.id) > BigInt(key.id)));
  }
  const renamed = await (await managerRpc(manager, 'rename_proxy_key', { id: key.id, name: 'Renamed' })).json();
  assert.equal(renamed.result.isError, false);
  const own = await list('manager', manager);
  assert.deepEqual(own.map(row => row.id), [first.id, second.id, management.id]);
  assert.ok(own[0].last_used_at);
  assert.doesNotMatch(JSON.stringify(own), /token_hash|mcp_[A-Za-z0-9_-]{43}/);
  assert.ok((await list('admin', admin)).some(row => row.id === first.id));
  const revoke = (area, auth, id) => call('/' + area + '/mcp-tokens/' + id + '/revoke', auth, 'POST');
  assert.equal((await revoke('manager', manager, administration.id)).status, 404);
  assert.equal((await revoke('admin', admin, first.id)).status, 204);
  assert.equal((await use('/report/mcp', first.token)).status, 401);
  assert.equal((await use('/report/mcp', second.token)).status, 200);
  const expired = await issue('admin', admin);
  await db.query('UPDATE mcp_access_tokens SET expires_at=UTC_TIMESTAMP(3) WHERE id=?', [expired.id]);
  assert.equal((await use('/report/mcp', expired.token)).status, 401);
  const patch = body => call('/admin/users/' + user, admin, 'PATCH', body);
  for (const status of ['SUSPENDED','ACTIVE']) assert.equal((await patch({ status })).status, 204);
  assert.equal((await use('/report/mcp', second.token)).status, 401);
  await db.query('INSERT INTO manager_sessions(token_hash,user_id,auth_version,expires_at) SELECT ?,id,manager_auth_version,UTC_TIMESTAMP()+INTERVAL 1 DAY FROM users WHERE id=?', [digest(manager),user]);
  assert.equal((await use('/manager/mcp', management.token)).status, 401);
  const third = await issue('manager', manager);
  assert.equal((await call('/manager/logout', manager, 'POST')).status, 204);
  assert.equal((await use('/report/mcp', third.token)).status, 200);
  for (const enabled of [false,true]) assert.ok((await call('/admin/users/' + user + '/manager', admin, 'PUT', { enabled })).ok);
  const [stored] = await db.query('SELECT token_hash,revoked_at FROM mcp_access_tokens WHERE id=?', [third.id]);
  assert.equal(stored.token_hash, digest(third.token));
  assert.ok(stored.revoked_at);
  assert.equal((await use('/report/mcp', third.token)).status, 401);
});
