import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('MCP authenticates every request and dispatches only matching allowlisted operations', async t => {
  const writes = [];
  let active = true;
  let upstreamInserts = 0;
  const assignment = { upstream_api_key_id: '13', priority: 5, status: 'ACTIVE' };
  const assignmentQueries = [];
  const db = { transaction: run => run({ query: async (sql, params) => {
    if (sql.startsWith('SELECT api_type FROM llm_inference_providers')) return [{ api_type: 'OPENAI_COMPATIBLE' }];
    if (sql.startsWith('INSERT INTO upstream_api_keys')) {
      upstreamInserts++;
      return { insertId: 23 };
    }
    assignmentQueries.push([sql, params]);
    return [{ id: '3' }];
  } }), query: async (sql, params) => {
    if (sql.includes('FROM admin_sessions')) return active ? [{ token_hash: 'admin' }] : [];
    if (sql.includes('FROM `users`')) {
      assert.deepEqual(params, ['500']);
      return [{ id: 501 }];
    }
    if (sql.includes('FROM `upstream_api_keys`')) {
      assert.deepEqual(params, ['12']);
      assert.doesNotMatch(sql, /encrypted_api_key|SELECT \*/);
      return [{ id: 13, provider_id: 2, status: 'ACTIVE' }];
    }
    if (sql.includes('FROM model_policies WHERE id=')) return [{ id: params[0], name: 'Team' }];
    if (sql.includes('FROM model_policy_rules')) {
      assert.deepEqual(params, ['3']);
      return [{ model_pattern: '*', policy: 'DENY' }, { model_pattern: 'fast', policy: 'ALLOW' }];
    }
    if (sql.includes('FROM role_upstream_model_aliases')) return [];
    if (sql.includes('FROM role_upstream_assignments')) {
      assert.deepEqual(params, ['3']);
      return [{ ...assignment }];
    }
    if (sql.includes('FROM `llm_inference_providers`')) {
      assert.deepEqual(params, ['2']);
      return [{ id: 3, name: 'Test provider', status: 'DISABLED' }];
    }
    writes.push([sql, params]);
    return { affectedRows: 1 };
  } };
  const server = createApp(db, { encryptionKey: Buffer.alloc(32) }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const version = '2026-07-28';
  const post = (method, params = {}, headers = {}) => fetch('http://127.0.0.1:' + server.address().port + '/admin/mcp', {
    method: 'POST', headers: { authorization: 'Bearer adm_test', 'content-type': 'application/json',
      'mcp-protocol-version': version, 'mcp-method': method, ...(params.name && { 'mcp-name': params.name }), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': {}
    }, ...params } })
  });
  const keyArgs = { provider_id: 3, name: 'OpenAI Main Key', api_key: 'test-only-secret' };
  const createKey = async args => (await (await post('tools/call', { name: 'create_upstream_key', arguments: args })).json()).result;
  const invalid = await createKey({ ...keyArgs, aws_region: 'us-east-1' });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.content[0].text, 'create_upstream_key failed. AWS region applies only to Bedrock keys');
  assert.equal(upstreamInserts, 0);
  const success = await createKey(keyArgs);
  assert.equal(success.isError, false);
  assert.equal(JSON.parse(success.content[0].text).id, 23);
  assert.equal(upstreamInserts, 1);
  const discover = await (await post('server/discover')).json();
  assert.deepEqual(discover.result.supportedVersions, [version, '2025-11-25', '2025-06-18']);
  const legacyPost = (method, params, id, negotiated) => fetch('http://127.0.0.1:' + server.address().port + '/admin/mcp', {
    method: 'POST', headers: { authorization: 'Bearer adm_test', 'content-type': 'application/json',
      ...(negotiated && { 'mcp-protocol-version': negotiated }) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  for (const protocolVersion of ['2025-11-25', '2025-06-18']) {
    const hello = await (await legacyPost('initialize', {
      protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' }
    }, 0)).json();
    assert.equal(hello.result.protocolVersion, protocolVersion);
    const ready = await legacyPost('notifications/initialized', {}, undefined, protocolVersion);
    assert.equal(ready.status, 202);
    assert.equal(await ready.text(), '');
    const catalogue = await (await legacyPost('tools/list', {}, 1, protocolVersion)).json();
    assert.equal(catalogue.result.tools.length, 38);
    assert.equal(catalogue.result.resultType, undefined);
    const call = await (await legacyPost('tools/call', { name: 'list_users', arguments: { after: 500 } }, 2, protocolVersion)).json();
    assert.deepEqual(JSON.parse(call.result.content[0].text).data, [{ id: 501 }]);
  }
  const list = await (await post('tools/list')).json();
  assert.equal(list.result.tools.length, 38);
  const upstreams = await (await post('tools/call', { name: 'list_upstreams', arguments: { after: 12 } })).json();
  assert.deepEqual(JSON.parse(upstreams.result.content[0].text), { data: [{ id: 13, provider_id: 2, status: 'ACTIVE' }], next_after: null });
  const policy = await (await post('tools/call', { name: 'list_model_policy_rules', arguments: { id: 3 } })).json();
  assert.deepEqual(JSON.parse(policy.result.content[0].text).rules,
    [{ model_pattern: '*', policy: 'DENY' }, { model_pattern: 'fast', policy: 'ALLOW' }]);
  const assignments = await (await post('tools/call', { name: 'list_role_upstreams', arguments: { id: 3 } })).json();
  assert.deepEqual(JSON.parse(assignments.result.content[0].text).data, [{ ...assignment, model_alias_ids: [] }]);
  const replace = async rows => (await (await post('tools/call', {
    name: 'set_role_upstreams', arguments: { id: 3, assignments: rows }
  })).json()).result;
  assert.equal((await replace([assignment, assignment])).isError, true);
  assert.equal(assignmentQueries.length, 0);
  assert.equal((await replace([assignment])).isError, false);
  assert.deepEqual(assignmentQueries.find(([sql]) => sql.startsWith('INSERT'))[1], ['3', '13', 5, 'ACTIVE']);
  assignmentQueries.length = 0;
  assert.equal((await replace([])).isError, false);
  assert.ok(assignmentQueries.some(([sql]) => sql.startsWith('DELETE')));
  assert.ok(!assignmentQueries.some(([sql]) => sql.startsWith('INSERT')));
  const providers = await (await post('tools/call', { name: 'list_providers', arguments: { after: 2 } })).json();
  assert.deepEqual(JSON.parse(providers.result.content[0].text), { data: [{ id: 3, name: 'Test provider', status: 'DISABLED' }], next_after: null });
  const args = { name: 'rename_proxy_key', arguments: { id: 3, name: 'Renamed' } };
  assert.equal((await post('tools/call', args, { authorization: 'Bearer pak_test' })).status, 401);
  assert.equal((await post('tools/call', args, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await (await post('tools/call', args, { 'mcp-name': 'create_user' })).json()).error.code, -32020);
  assert.deepEqual(writes, []);
  const rename = await (await post('tools/call', args)).json();
  assert.equal(rename.result.isError, false);
  assert.deepEqual(writes[0][1], ['Renamed','3']);
  const users = await (await post('tools/call', { name: 'list_users', arguments: { after: 500 } })).json();
  assert.deepEqual(JSON.parse(users.result.content[0].text), { data: [{ id: 501 }], next_after: null });
  const injection = await (await post('tools/call', { ...args, arguments: { ...args.arguments, id: '../password' } })).json();
  assert.equal(injection.result.isError, true);
  active = false;
  assert.equal((await post('tools/call', args)).status, 401);
  assert.equal(writes.length, 1);
});

test('report MCP isolates the usage tool and shares session checks and usage filters', async t => {
  const queries = [];
  let temporary = false;
  const db = { query: async (sql, params) => {
    if (sql.includes('FROM admin_sessions')) return [{ token_hash: 'admin' }];
    if (sql.includes('FROM manager_sessions')) return [{ manager_password_temporary: temporary }];
    queries.push({ sql, params });
    return sql.includes('c.currency') ? [{ bucket: 'fast', currency: 'USD', estimated_cost: '1.01' }] : [{ bucket: 'fast', usage_events: 3 }];
  } };
  const server = createApp(db, {}).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (token, method, params) => fetch('http://127.0.0.1:' + server.address().port + '/report/mcp', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const manager = 'mgr_' + 'a'.repeat(43);
  for (const token of ['adm_test', manager]) {
    const list = await (await post(token, 'tools/list', {})).json();
    assert.deepEqual(list.result.tools.map(tool => tool.name), ['get_usage_report']);
  }
  const call = (name, args) => post(manager, 'tools/call', { name, arguments: args });
  assert.equal((await (await call('create_user', {})).json()).error.code, -32602);
  assert.equal((await (await call('get_usage_report', { group_ids: [] })).json()).result.isError, true);
  assert.equal(queries.length, 0);
  const report = await (await call('get_usage_report', { group_by: 'model', user_ids: [7], group_ids: ['3'], provider_id: 2 })).json();
  assert.equal(JSON.parse(report.result.content[0].text).data[0].costs[0].estimated_cost, '1.01');
  assert.equal(queries.length, 2);
  for (const { sql, params } of queries) {
    assert.match(sql, /e.model AS bucket/);
    assert.deepEqual(params.slice(2), ['7', '2', '3']);
  }
  temporary = true;
  assert.equal((await post(manager, 'tools/list', {})).status, 403);
  assert.equal((await post('pak_test', 'tools/list', {})).status, 401);
});
