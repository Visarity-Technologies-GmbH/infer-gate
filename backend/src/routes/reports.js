import { Router } from 'express';
import { fail } from '../errors.js';
const usageGroups = { category: 'e.category', company: "'company'", user: 'e.user_id', proxy_key: 'e.proxy_api_key_id', upstream_key: 'e.upstream_api_key_id', provider: 'e.provider_id', model: 'e.model', day: 'DATE(e.timestamp)', week: 'YEARWEEK(e.timestamp,3)', month: "DATE_FORMAT(e.timestamp,'%Y-%m')" };
function usageGroup(value, fallback) {
  const key = value === undefined ? fallback : value;
  if (typeof key !== 'string' || !Object.hasOwn(usageGroups, key)) fail(400, 'invalid_group', 'Invalid grouping');
  return usageGroups[key];
}
function interval(query) {
  const end = query.end ? new Date(query.end) : new Date();
  const start = query.start ? new Date(query.start) : new Date(end.getTime() - 30 * 86400000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) fail(400, 'invalid_interval', 'Use valid start and end timestamps with start before end');
  return [start, end];
}
export function filters(query, alias, column) {
  const params = interval(query), clauses = [`${alias}.${column}>=?`, `${alias}.${column}<?`];
  for (const name of ['user_id', 'proxy_api_key_id', 'upstream_api_key_id', 'provider_id', 'model', 'request_status']) {
    if (query[name] !== undefined) {
      if (name === 'user_id') {
        const values = Array.isArray(query[name]) ? query[name] : [query[name]];
        if (!values.length || values.length > 500 || values.some(value => typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value))) fail(400, 'invalid_filter', 'Invalid user selection');
        const ids = [...new Set(values)];
        clauses.push(`${alias}.user_id IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
        continue;
      }
      if (typeof query[name] !== 'string' || query[name].length > 255) fail(400, 'invalid_filter', 'Invalid filter');
      if (name.endsWith('_id') && !/^[1-9]\d{0,18}$/.test(query[name])) fail(400, 'invalid_filter', 'Invalid identifier filter');
      clauses.push(`${alias}.${name === 'model' && column === 'started_at' ? 'model_requested' : name}=?`); params.push(query[name]);
    }
  }
  if (query.group_id !== undefined) {
    const values = Array.isArray(query.group_id) ? query.group_id : [query.group_id];
    if (!values.length || values.length > 500 || values.some(value => typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value))) fail(400, 'invalid_filter', 'Invalid group selection');
    const ids = [...new Set(values)];
    clauses.push(`EXISTS (SELECT 1 FROM user_groups g WHERE g.user_id=${alias}.user_id AND g.group_id IN (${ids.map(() => '?').join(',')}))`); params.push(...ids);
  }
  return { where: clauses.join(' AND '), params };
}
export async function usageReport(db, query) {
  const group = usageGroup(query.group_by, 'company');
  const { where, params } = filters(query, 'e', 'timestamp');
  const sums = ['input_tokens','cached_input_tokens','cache_write_input_tokens','cache_write_5m_tokens','cache_write_1h_tokens','output_tokens','reasoning_tokens','total_tokens'].map(name => `SUM(e.${name}) AS ${name},COUNT(e.${name}) AS ${name}_reported_events`).join(',');
  const [data, costs] = await Promise.all([
    db.query(`SELECT ${group} AS bucket,COUNT(*) AS usage_events,${sums},
      COUNT(CASE WHEN c.status='COMPLETE' THEN 1 END) AS priced_events,
      COUNT(CASE WHEN c.status='PARTIAL' THEN 1 END) AS partial_events,
      COUNT(CASE WHEN c.status='UNSUPPORTED' THEN 1 END) AS unsupported_events,
      COUNT(CASE WHEN c.id IS NULL OR c.status='UNPRICED' THEN 1 END) AS unpriced_events
      FROM usage_events e LEFT JOIN usage_costs c ON c.usage_event_id=e.id WHERE ${where}
      GROUP BY bucket ORDER BY bucket LIMIT 1000`, params),
    db.query(`SELECT ${group} AS bucket,c.currency,SUM(CASE WHEN c.status='COMPLETE' THEN c.known_cost END) AS estimated_cost,SUM(c.known_cost) AS known_cost,
      COUNT(CASE WHEN c.known_cost IS NOT NULL AND c.requested_cost IS NOT NULL THEN 1 END) AS saved_events,
      SUM(CASE WHEN c.status='COMPLETE' AND c.known_cost IS NOT NULL AND c.requested_cost IS NOT NULL THEN c.requested_cost END) AS total_reducible_cost,
      SUM(CASE WHEN c.status='COMPLETE' AND c.known_cost IS NOT NULL AND c.requested_cost IS NOT NULL THEN c.known_cost END) AS actual_reduced_cost,
      CAST(1 - SUM(CASE WHEN c.status='COMPLETE' AND c.known_cost IS NOT NULL AND c.requested_cost IS NOT NULL THEN c.known_cost END) /
        NULLIF(SUM(CASE WHEN c.status='COMPLETE' AND c.known_cost IS NOT NULL AND c.requested_cost IS NOT NULL THEN c.requested_cost END),0)
        AS DOUBLE) AS estimated_saving_percent
      FROM usage_events e JOIN usage_costs c ON c.usage_event_id=e.id WHERE ${where}
      GROUP BY bucket,c.currency ORDER BY bucket,c.currency LIMIT 1000`, params)
  ]);
  return { data: data.map(row => ({ ...row, costs: costs.filter(cost => String(cost.bucket) === String(row.bucket)) })) };
}

export function reportsRouter(db) {
  const router = Router();
  router.get('/usage/models', async (req, res) => {
    const data = await db.query("SELECT DISTINCT model FROM usage_events WHERE model IS NOT NULL AND model<>'' ORDER BY model");
    res.json({ data: data.map(row => row.model) });
  });
  router.get('/usage/categories', async (req, res) => {
    const group = usageGroup(req.query.group_by, 'category');
    const { where, params } = filters(req.query, 'e', 'timestamp');
    const data = await db.query(`SELECT ${group} AS bucket,COUNT(*) AS usage_events,
      COUNT(CASE WHEN e.complexity=0 THEN 1 END) AS easy_events,
      COUNT(CASE WHEN e.complexity=1 THEN 1 END) AS medium_events,
      COUNT(CASE WHEN e.complexity=2 THEN 1 END) AS hard_events,
      COUNT(CASE WHEN e.complexity IS NULL THEN 1 END) AS unknown_complexity_events
      FROM usage_events e WHERE ${where}
      GROUP BY bucket ORDER BY usage_events DESC,bucket`, params);
    res.json({ data });
  });
  router.get('/usage', async (req, res) => res.json(await usageReport(db, req.query)));
  router.get('/requests', async (req, res) => {
    const { where, params } = filters(req.query, 'r', 'started_at');
    const before = req.query.before;
    if (before !== undefined && (typeof before !== 'string' || !/^[1-9]\d{0,18}$/.test(before))) fail(400, 'invalid_cursor', 'Invalid cursor');
    // Select one event per request so multiple accounting events cannot duplicate
    // rows or alter request pagination. IDs give a deterministic latest event.
    const data = await db.query(`SELECT r.*,u.name AS user_name,
      COALESCE(e.model,r.model_resolved,r.model_requested) AS model,
      e.category,e.sensitive_data,e.complexity,
      COALESCE(e.requestedModel,e.model,r.model_resolved,r.model_requested) AS requestedModel
      FROM api_requests r LEFT JOIN users u ON u.id=r.user_id
      LEFT JOIN usage_events e ON e.id=(
        SELECT latest.id FROM usage_events latest WHERE latest.api_request_id=r.id ORDER BY latest.id DESC LIMIT 1
      ) WHERE ${where}${before ? ' AND r.id<?' : ''} ORDER BY r.id DESC LIMIT 100`, before ? [...params, before] : params);
    res.json({ data, next_before: data.length === 100 ? data.at(-1).id : null });
  });
  router.get('/dashboard', async (req, res) => {
    const { where, params } = filters(req.query, 'r', 'started_at');
    const [data] = await db.query(`SELECT COUNT(*) AS total_requests,SUM(request_status='SUCCESS') AS successful_requests,SUM(request_status='FAILED') AS failed_requests,SUM(request_status='REJECTED') AS rejected_requests,SUM(request_status='CANCELLED') AS cancelled_requests,AVG(duration_ms) AS average_duration_ms FROM api_requests r WHERE ${where}`, params);
    res.json(data);
  });
  return router;
}
