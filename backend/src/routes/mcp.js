import { HttpError } from '../errors.js';

import { compactionOptions } from '../services/system-prompt-compaction.js';

const version = '2026-07-28';
const handshakeVersions = ['2025-11-25', '2025-06-18'];
const supportedVersions = [version, ...handshakeVersions];
const serverInfo = { name: 'InferGate', version: '0.1.0' };
export const identifier = { type: ['string', 'integer'], pattern: '^[1-9][0-9]{0,18}$', minimum: 1 };
const nullableText = { type: ['string', 'null'] };
const fields = {
  debug_enabled: { type: 'boolean', description: 'Enable debug capture for this role only when global debug logging is also enabled. Defaults to false.' },
  system_prompt_compaction: { type: 'object', additionalProperties: false, properties: Object.fromEntries(compactionOptions.map(key => [key, { type: 'boolean' }])) },
  aws_region: { type: 'string', description: 'Required for AWS Bedrock keys. Omit for OpenAI and all other providers.' },
  enabled: { type: 'boolean' }, period: { enum: ['DAILY', 'WEEKLY'] }, basis: { enum: ['TOKENS', 'COST'] },
  amount: { type: 'string', description: 'Millions of tokens or estimated USD.' },
  status: { enum: ['ACTIVE', 'DISABLED'] },
  request_compression_c: { enum: ['NONE', 'GZIP', 'ZSTD'], description: 'Compression for upstream Chat Completions requests.' },
  request_compression_r: { enum: ['NONE', 'GZIP', 'ZSTD'], description: 'Compression for upstream Responses requests.' },
  request_compression_m: { enum: ['NONE', 'GZIP', 'ZSTD'], description: 'Compression for upstream Messages requests.' },
  api_type: { enum: ['OPENAI_COMPATIBLE', 'ANTHROPIC', 'GEMINI', 'AWS_BEDROCK', 'OPENAI_ANTHROPIC'] },
  role_id: { anyOf: [identifier, { type: 'null' }] }, classification_handler_id: { anyOf: [identifier, { type: 'null' }] },
  maxToken: { type: ['integer', 'null'], minimum: 1 },
  description: nullableText, anthropic_api_url: nullableText,
  prompt_script: nullableText, evaluation_script: nullableText, input_script: nullableText, output_script: nullableText,
  assignments: { type: 'array', maxItems: 100, items: { type: 'object', properties: {
    upstream_api_key_id: identifier, priority: { type: 'integer', minimum: -2147483647, maximum: 2147483647 },
    status: { enum: ['ACTIVE', 'DISABLED'] }
  }, required: ['upstream_api_key_id', 'priority', 'status'], additionalProperties: false } },
  rules: { type: 'array', maxItems: 100, items: { type: 'object', properties: {
    model_pattern: { type: 'string' }, policy: { enum: ['ALLOW', 'DENY'] }
  }, required: ['model_pattern', 'policy'], additionalProperties: false } }
};
const tools = new Map();

// Paths and injected fields are fixed by the server. IDs are validated before path substitution.
function register(name, method, path, required = [], optional = [], fixed = {}, description = name.replaceAll('_', ' ')) {
  const pathFields = [...path.matchAll(/:(\w+)/g)].map(match => match[1]);
  const names = [...pathFields, ...required, ...optional];
  const properties = Object.fromEntries(names.map(key => [key, fields[key] ??
    (key === 'id' || key.endsWith('_id') || key === 'after' ? identifier : { type: 'string' })]));
  const inputSchema = { type: 'object', properties, required: [...pathFields, ...required], additionalProperties: false };
  tools.set(name, { definition: { name, description, inputSchema }, method, path, fixed });
}
for (const [resource, path] of [['users','users'], ['groups','groups'], ['proxy_keys','proxy-keys'], ['roles','roles'], ['providers','providers'], ['model_policies','model-policies']])
  register('list_' + resource, 'GET', '/' + path, [], ['after'], {}, 'List ' + resource.replaceAll('_',' ') + '. Pass next_after as after until it is null.');
register('create_user', 'POST', '/users', ['name','email']);
register('rename_user', 'PATCH', '/users/:id', ['name']);
register('suspend_user', 'PATCH', '/users/:id', [], [], { status: 'SUSPENDED' });
register('get_usage_cap', 'GET', '/users/:id/usage-limit', [], [], {}, 'Read the usage cap for a user ID from list_users. Enabled caps include current consumption, enforcement cutoff, reset time and blocked status. Amounts are in millions of tokens or USD.');
register('set_usage_cap', 'PUT', '/users/:id/usage-limit', ['enabled','period','basis','amount']);
register('promote_to_manager', 'PUT', '/users/:id/manager', [], [], { enabled: true }, 'Grant manager access and return the temporary password.');
register('create_usage_link', 'POST', '/users/:id/viewing-key', [], [], {}, 'Replace the user’s viewing key and return a dashboard-relative link.');
register('create_group', 'POST', '/groups', ['name'], ['description']);
register('rename_group', 'PATCH', '/groups/:id', ['name']);
register('assign_group_user', 'PUT', '/groups/:group_id/users/:user_id');
register('create_proxy_key', 'POST', '/proxy-keys', ['user_id','name']);
register('rename_proxy_key', 'PATCH', '/proxy-keys/:id', ['name']);
register('assign_proxy_key_role', 'PUT', '/proxy-keys/:id/role', ['role_id']);
register('revoke_proxy_key', 'POST', '/proxy-keys/:id/revoke');
register('list_upstreams', 'GET', '/upstream-keys', [], ['after'], {}, 'List configured upstream keys with provider ID, status and safe fingerprint. Pass next_after as after until it is null.');
register('create_upstream_key', 'POST', '/upstream-keys', ['provider_id','name','api_key'], ['aws_region','request_compression_c','request_compression_r','request_compression_m'], {}, 'Create an upstream key. A successful result contains the new key ID.');
register('edit_upstream_key', 'PATCH', '/upstream-keys/:id', [], ['name','api_key','aws_region','request_compression_c','request_compression_r','request_compression_m']);
register('show_upstream_models', 'GET', '/upstream-keys/:id/models');
register('disable_upstream_key', 'PATCH', '/upstream-keys/:id', [], [], { status: 'DISABLED' });
register('create_provider', 'POST', '/providers', ['name','api_url'], ['api_type','anthropic_api_url']);
register('edit_provider', 'PATCH', '/providers/:id', [], ['name','api_url','api_type','anthropic_api_url']);
register('disable_provider', 'PATCH', '/providers/:id', [], [], { status: 'DISABLED' });
const roleOptions = ['debug_enabled','description','status','classification_handler_id','prompt_script','evaluation_script','input_script','output_script','system_prompt_compaction'];
register('list_role_models', 'GET', '/roles/:id/models', [], [], {}, 'List the distinct model IDs available to this active role across its upstreams after applying its model policy. Supply a role ID from list_roles.');
register('list_role_upstreams', 'GET', '/roles/:id/assignments', [], [], {}, 'List upstream key IDs assigned to this role, with priority and assignment status in routing order.');
register('set_role_upstreams', 'PUT', '/roles/:id/assignments', ['assignments'], [], {}, 'Replace all upstream assignments for this role. Include every key to retain. An empty array clears all assignments.');
register('create_role', 'POST', '/roles', ['name','model_policy_ids'], roleOptions);
register('edit_role', 'PUT', '/roles/:id', ['name','model_policy_ids'], roleOptions, {}, 'Update role configuration. Supply one or more model_policy_ids; a model is allowed if any attached policy allows it.');
register('list_model_policy_rules', 'GET', '/model-policies/:id', [], [], {}, 'Return the selected model policy and its complete ordered list of ALLOW and DENY rules. Supply a policy ID from list_model_policies.');
register('create_model_policy', 'POST', '/model-policies', ['name','rules'], ['description']);
register('edit_model_policy', 'PUT', '/model-policies/:id', ['name','rules'], ['description'], {}, 'Replace the policy name, description and complete rule list.');
const handlerOptions = ['description','json_template','maxToken'];
register('create_classification_handler', 'POST', '/classification-handlers', ['name','api_url','api_key'], handlerOptions);
register('edit_classification_handler', 'PATCH', '/classification-handlers/:id', [], ['name','api_url','api_key', ...handlerOptions]);

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function validId(value) {
  return (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d{0,18}$/.test(String(value));
}

// Invoke the same resource router in process. The caller cannot supply an HTTP route or method.
function invoke(router, tool, args, response, manager) {
  const body = { ...args, ...tool.fixed };
  const url = tool.path.replace(/:(\w+)/g, (_, key) => { delete body[key]; return String(args[key]); });
  const query = args.after === undefined ? {} : { after: String(args.after) };
  return new Promise((resolve, reject) => {
    const result = {
      status() { return this; }, json: resolve, sendStatus: () => resolve({ success: true }),
      on: response.on.bind(response), off: response.off.bind(response),
      get destroyed() { return response.destroyed; }
    };
    router.handle({ manager, managerMcp: !!manager, method: tool.method, url, query, body: tool.definition.name === 'set_role_upstreams' ? body.assignments : body }, result, error => reject(error ?? new Error('Missing admin operation')));
  });
}

const managerToolNames = [
  'list_users', 'create_user', 'rename_user', 'suspend_user', 'get_usage_cap', 'set_usage_cap', 'create_usage_link',
  'list_groups', 'create_group', 'rename_group', 'assign_group_user',
  'list_proxy_keys', 'create_proxy_key', 'rename_proxy_key', 'assign_proxy_key_role', 'revoke_proxy_key', 'list_roles', 'list_role_models'
];
const managerTools = new Map(managerToolNames.map(name => [name, tools.get(name)]));

export function mcpHandler(router, config, { manager = false } = {}) {
  const handler = mcpEndpoint(manager ? managerTools : tools, config,
    (tool, args, res, req) => invoke(router, tool, args, res, req.manager));
  return (req, res) => {
    if (manager && !req.manager) return res.sendStatus(403);
    return handler(req, res);
  };
}

export function mcpEndpoint(catalogue, config, execute) {
  let windowEnd = 0;
  let calls = 0;
  return async (req, res) => {
    if (req.headers.origin !== undefined && req.headers.origin !== config.mcpAllowedOrigin) return res.sendStatus(403);
    if (req.method !== 'POST') return res.set('Allow', 'POST').sendStatus(405);
    if (!req.is('application/json')) return res.sendStatus(415);
    const { id, jsonrpc, method, params } = req.body ?? {};
    const validRequestId = typeof id === 'string' || Number.isSafeInteger(id);
    const error = (status, code, message, data) => res.status(status).json({ jsonrpc: '2.0', ...(validRequestId && { id }), error: { code, message, data } });
    if (jsonrpc !== '2.0' || typeof method !== 'string')
      return error(400, -32600, 'Invalid JSON-RPC request');
    const meta = params?._meta;
    const requested = meta?.['io.modelcontextprotocol/protocolVersion'];
    const headerVersion = req.get('MCP-Protocol-Version');
    const modern = requested !== undefined || req.get('Mcp-Method') !== undefined ||
      req.get('Mcp-Name') !== undefined || headerVersion === version;
    const handshake = !modern && method === 'initialize';
    const legacy = !modern && handshakeVersions.includes(headerVersion);
    if (legacy && method === 'notifications/initialized' && id === undefined)
      return res.status(202).end();
    if (!validRequestId) return error(400, -32600, 'Invalid JSON-RPC request ID');
    if (handshake) {
      if (typeof params?.protocolVersion !== 'string' || !object(params.capabilities) ||
          typeof params.clientInfo?.name !== 'string' || typeof params.clientInfo.version !== 'string')
        return error(400, -32602, 'Invalid initialize parameters');
      const protocolVersion = handshakeVersions.includes(params.protocolVersion) ? params.protocolVersion : handshakeVersions[0];
      return res.json({ jsonrpc, id, result: { protocolVersion, serverInfo, capabilities: { tools: {} } } });
    }
    if (!legacy) {
      let name = req.get('Mcp-Name');
      if (name?.startsWith('=?base64?') && name.endsWith('?=')) {
        const encoded = name.slice(9, -2);
        const bytes = Buffer.from(encoded, 'base64');
        name = bytes.toString('base64') === encoded ? bytes.toString('utf8') : null;
      }
      if (!requested || requested !== req.get('MCP-Protocol-Version') || method !== req.get('Mcp-Method') ||
          (method === 'tools/call' && (!name || name !== params?.name)))
        return error(400, -32020, 'Required MCP headers missing or inconsistent with the request');
      if (requested !== version) return error(400, -32022, 'Unsupported protocol version', { supported: supportedVersions, requested });
      const client = meta['io.modelcontextprotocol/clientInfo'];
      if ((client !== undefined && (typeof client?.name !== 'string' || typeof client?.version !== 'string')) || !object(meta['io.modelcontextprotocol/clientCapabilities']))
        return error(400, -32602, 'Invalid client metadata');
    }
    const complete = result => res.json({ jsonrpc, id, result: legacy ? result : { resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo }, ...result } });
    if (legacy && method === 'ping') return complete({});
    if (!legacy && method === 'server/discover') return complete({ supportedVersions, capabilities: { tools: {} } });
    if (method === 'tools/list') return complete({ tools: Array.from(catalogue.values(), tool => tool.definition) });
    if (method !== 'tools/call') return error(404, -32601, 'Method not found');
    const tool = catalogue.get(params?.name);
    if (!tool) return error(400, -32602, 'Unknown tool');
    const args = params.arguments === undefined ? {} : params.arguments;
    const { required, properties } = tool.definition.inputSchema;
    const toolResult = (text, isError = false) => complete({ content: [{ type: 'text', text: isError ? `${tool.definition.name} failed. ${text}` : text }], isError });
    if (!object(args)) return error(400, -32602, 'Tool arguments must be an object');
    if (required.some(key => !Object.hasOwn(args, key)) ||
        Object.keys(args).some(key => !Object.hasOwn(properties, key) ||
          ((key === 'id' || key.endsWith('_id') || key === 'after') &&
          !(args[key] === null && ['role_id','classification_handler_id'].includes(key)) && !validId(args[key]))))
      return toolResult('Invalid tool arguments', true);
    // Each endpoint shares one budget across its sessions.
    const now = Date.now();
    if (now >= windowEnd) { calls = 0; windowEnd = now + 60_000; }
    if (++calls > 120) {
      res.set('Retry-After', String(Math.ceil((windowEnd - now) / 1000)));
      return error(429, -32000, 'Tool call rate limit exceeded');
    }
    try {
      const value = await execute(tool, args, res, req);
      return toolResult(JSON.stringify(params.name === 'create_usage_link' ? { link: '/#user-' + value.key } : value));
    } catch (cause) {
      const conflict = ['ER_DUP_ENTRY','ER_NO_REFERENCED_ROW_2'].includes(cause.code);
      return toolResult(cause instanceof HttpError ? cause.message : conflict ? 'Conflicting or missing related record' : 'Internal server error', true);
    }
  };
}
