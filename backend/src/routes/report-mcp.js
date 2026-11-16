import { Router, json } from 'express';
import { fail } from '../errors.js';
import { adminSession } from './admin.js';
import { mcpAuthentication } from './mcp-tokens.js';
import { managerSession } from './manager.js';
import { identifier, validId, mcpEndpoint } from './mcp.js';
import { usageReport } from './reports.js';

const ids = { type: 'array', items: identifier, minItems: 1, maxItems: 500 };
const properties = {
  start: { type: 'string', description: 'Inclusive UTC start date or ISO timestamp with timezone.' },
  end: { type: 'string', description: 'Exclusive UTC end date or ISO timestamp with timezone.' },
  user_ids: ids, group_ids: ids,
  proxy_api_key_id: identifier, upstream_api_key_id: identifier, provider_id: identifier,
  model: { type: 'string', description: 'Model sent upstream after routing.' },
  request_status: { enum: ['RECEIVED','FORWARDED','SUCCESS','FAILED','REJECTED','CANCELLED'] },
  group_by: { enum: ['company','user','proxy_key','upstream_key','provider','model','category','day','week','month'] }
};
const definition = {
  name: 'get_usage_report',
  description: 'Report organization-wide token usage, pricing coverage, estimated costs and comparable savings by currency. Defaults to company totals over the last 30 days. Multiple groups match any current membership and intersect with any selected users.',
  inputSchema: { type: 'object', properties, required: [], additionalProperties: false }
};

function reportQuery(args) {
  const query = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'user_ids' || key === 'group_ids') {
      if (!Array.isArray(value) || !value.length || value.length > 500 || !value.every(validId))
        fail(400, 'invalid_filter', 'Use 1 to 500 positive identifiers per selection');
      query[key === 'user_ids' ? 'user_id' : 'group_id'] = value.map(String);
    } else if (key.endsWith('_id')) {
      query[key] = String(value); // Single IDs were validated by the MCP dispatcher.
    } else {
      if (typeof value !== 'string' || (properties[key].enum && !properties[key].enum.includes(value)))
        fail(400, 'invalid_filter', 'Invalid report filter: ' + key);
      if ((key === 'start' || key === 'end') && !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/i.test(value))
        fail(400, 'invalid_interval', 'Use a UTC date or an ISO timestamp with timezone');
      query[key] = value;
    }
  }
  return query;
}

export function reportMcpRouter(db, config) {
  const router = Router();
  const admin = adminSession(db), manager = managerSession(db);
  router.all('/mcp', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    mcpAuthentication(db, 'REPORT', (req, res, next) => {
    const authenticate = req.get('authorization')?.startsWith('Bearer mgr_') ? manager : admin;
    return authenticate(req, res, next);
  }), json({ limit: '64kb' }), mcpEndpoint(new Map([[definition.name, { definition }]]), config,
    (_tool, args) => usageReport(db, reportQuery(args))));
  return router;
}
