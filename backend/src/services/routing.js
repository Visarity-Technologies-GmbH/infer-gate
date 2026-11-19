import { digest } from '../security/credentials.js';
import { fail } from '../errors.js';
export async function authenticate(db, authorization) {
  const match = /^Bearer (pak_[A-Za-z0-9_-]+)$/i.exec(authorization || '');
  if (!match) fail(401, 'invalid_api_key', 'Invalid proxy API key');
  const [key] = await db.query(`SELECT k.id, k.name AS proxy_api_key_name, k.user_id, u.name AS user_name, u.email AS user_email,
    k.status, k.expires_at <= UTC_TIMESTAMP(3) AS expired, k.role_id, r.name AS role_name, r.status AS role_status, r.debug_enabled AS role_debug_enabled, r.classification_handler_id, r.evaluation_script, r.prompt_script, r.input_script, r.output_script, r.system_prompt_compaction,
    r.updated_at AS role_updated_at, h.maxToken AS classification_max_token,
    SHA2(CAST(JSON_ARRAY(h.api_url,h.json_template,h.key_fingerprint,h.maxToken) AS CHAR),256) AS classification_config_hash,
    u.status AS user_status FROM proxy_api_keys k JOIN users u ON u.id=k.user_id LEFT JOIN roles r ON r.id=k.role_id
    LEFT JOIN classification_handlers h ON h.id=r.classification_handler_id WHERE key_hash=?`, [digest(match[1])]);
  if (!key) fail(401, 'invalid_api_key', 'Invalid proxy API key');
  return key;
}
export function authorize(key) {
  if (key.status !== 'ACTIVE') fail(401, 'revoked_api_key', 'Proxy API key is revoked');
  // mysql2 returns SQL comparison results as strings with bigNumberStrings enabled.
  if (Number(key.expired) === 1) fail(401, 'expired_api_key', 'Proxy API key has expired');
  if (key.user_status !== 'ACTIVE') fail(403, 'user_suspended', 'User is suspended');
}
export function evaluatedModel(requestedModel, candidates, availableModels) {
  return candidates?.find(model => availableModels.has(model)) ?? requestedModel;
}
export async function route(db, roleId) {
  const [row] = await db.query(`SELECT k.id AS upstream_api_key_id, k.name AS upstream_name, k.encrypted_api_key, k.aws_region, k.status AS key_status,
    p.id AS provider_id, p.api_url, p.anthropic_api_url, p.api_type, k.request_compression_c, k.request_compression_r, k.request_compression_m, p.status AS provider_status FROM role_upstream_assignments a
    JOIN upstream_api_keys k ON k.id=a.upstream_api_key_id JOIN llm_inference_providers p ON p.id=k.provider_id
    WHERE a.role_id=? AND a.status='ACTIVE' ORDER BY a.priority DESC, a.id ASC LIMIT 1`, [roleId]);
  if (!row) fail(503, 'missing_upstream_assignment', 'No upstream assignment is configured');
  if (row.key_status !== 'ACTIVE') fail(503, 'upstream_key_disabled', 'Assigned upstream key is disabled');
  if (row.provider_status !== 'ACTIVE') fail(503, 'provider_disabled', 'Assigned provider is disabled');
  return row;
}

// Discovery queries every usable assignment, including distinct keys for the same provider.
export async function modelListRoutes(db, roleId) {
  const rows = await db.query(`SELECT a.id AS role_upstream_assignment_id, k.id AS upstream_api_key_id, k.name AS upstream_name, k.encrypted_api_key, k.aws_region, k.status AS key_status,
    p.id AS provider_id, p.api_url, p.anthropic_api_url, p.api_type, k.request_compression_c, k.request_compression_r, k.request_compression_m, p.status AS provider_status FROM role_upstream_assignments a
    JOIN upstream_api_keys k ON k.id=a.upstream_api_key_id JOIN llm_inference_providers p ON p.id=k.provider_id
    WHERE a.role_id=? AND a.status='ACTIVE' ORDER BY a.priority DESC, a.id ASC`, [roleId]);
  const usable = rows.filter(row => row.key_status === 'ACTIVE' && row.provider_status === 'ACTIVE');
  if (!usable.length) fail(503, 'missing_upstream_assignment', 'No active upstream assignment with an active key and provider is configured');
  return usable;
}

export async function routeForModel(db, roleId, model, lookup) {
  if (!model) return route(db, roleId);
  const assignments = await modelListRoutes(db, roleId);
  let unavailable = false;
  for (const assignment of assignments) {
    const catalogue = await lookup(assignment);
    if (!catalogue) { unavailable = true; continue; }
    const available = new Set(catalogue.data.map(entry => entry.id));
    if (available.has(model)) return { ...assignment, resolved_model: model };
    const aliases = await db.query(`SELECT DISTINCT entry.model_upstream
      FROM role_upstream_model_aliases assigned
      JOIN model_alias_entries entry ON entry.model_alias_id=assigned.model_alias_id
      WHERE assigned.role_upstream_assignment_id=? AND entry.model_alias=?`, [assignment.role_upstream_assignment_id, model]);
    const match = aliases.find(alias => available.has(alias.model_upstream));
    if (match) return { ...assignment, resolved_model: match.model_upstream };
  }
  if (unavailable) fail(503, 'model_discovery_unavailable', 'Upstream model discovery temporarily unavailable');
  fail(404, 'model_not_available', 'Requested model is not available through any active upstream assignment');
}
