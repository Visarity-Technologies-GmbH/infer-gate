import { mcpAuthentication, mcpTokensRouter, revokeManagerTokens } from './mcp-tokens.js';
import { mcpHandler } from './mcp.js';
import { managerAccountsRouter, managerPermissions } from './manager.js';
import { userViewingKeysRouter } from './user-usage.js';
import { debugLoggingEnabled } from '../services/debug-log.js';
import { usageMaintenanceRouter } from './usage-maintenance.js';
import { usageLimitsRouter } from './usage-limits.js';
import { pricingRouter } from './pricing.js';
import { rolesRouter, checkManagerRole } from './roles.js';
import { modelPoliciesRouter } from './model-policies.js';
import { modelAliasesRouter } from './model-aliases.js';
import { classificationHandlersRouter } from './classification-handlers.js';
import { validateUpstreamCredential } from '../security/upstream-credential.js';
import { checkUpstreamKey, listUpstreamModels } from '../services/upstream-key-check.js';
import { checkUpstreamCompression } from '../services/upstream-compression-check.js';
import { BEDROCK_API_URL, BEDROCK_REGIONS, validateRegion } from '../providers/bedrock.js';
import { Router, json } from 'express';
import { digest, token, hashPassword, verifyPassword, encrypt } from '../security/credentials.js';
import { reportsRouter } from './reports.js';
import { fail, HttpError } from '../errors.js';
const text = (value, max = 255) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_input', 'Invalid or missing text field');
  return value;
};
const id = value => { if (!/^[1-9]\d{0,18}$/.test(String(value))) fail(400, 'invalid_id', 'Invalid identifier'); return String(value); };
const choice = (value, values) => { if (!values.includes(value)) fail(400, 'invalid_input', 'Invalid field value'); return value; };
const password = value => { text(value, 1024); if (value.length < 12) fail(400, 'weak_password', 'Password must contain at least 12 characters'); return value; };
function proxyKeyExpiry(value) {
  if (value === null) return null;
  if (typeof value === 'string' && /^[1-9]\d{3}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime()) && date.toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')))
      return date;
  }
  fail(400, 'invalid_expiry', 'Supply a valid UTC timestamp or null');
}
function providerUrl(value) {
  text(value, 2048); if (value === BEDROCK_API_URL) return value; let url;
  try { url = new URL(value); } catch { fail(400, 'invalid_url', 'Invalid provider URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(400, 'invalid_url', 'Use an HTTP(S) API base URL without credentials, query or fragment');
  return url.href.replace(/\/$/, '');
}
function fields(body, schema, partial = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_input', 'Expected an object');
  for (const key of Object.keys(body)) if (!schema[key]) fail(400, 'invalid_input', `Unknown field: ${key}`);
  const result = {};
  for (const [key, validate] of Object.entries(schema)) if (!partial || body[key] !== undefined) result[key] = validate(body[key]);
  if (!Object.keys(result).length) fail(400, 'invalid_input', 'No fields supplied');
  return result;
}
export function adminSession(db) {
  return async (req, res, next) => {

    const match = /^Bearer (adm_[A-Za-z0-9_-]+)$/.exec(req.get('authorization') || '');
    if (!match) fail(401, 'admin_auth_required', 'Administrator authentication required');
    const rows = await db.query('SELECT token_hash FROM admin_sessions WHERE token_hash=? AND expires_at > UTC_TIMESTAMP(3)', [digest(match[1])]);
    if (!rows.length) fail(401, 'invalid_session', 'Administrator session expired or invalid');
    req.sessionHash = rows[0].token_hash; next();
  };
}

export function adminRouter(db, config, dependencies = {}, { manager = false } = {}) {
  const entry = Router();
  entry.use(json({ limit: '64kb' }));
  entry.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const router = Router();
  if (manager) {
    entry.all('/mcp', mcpHandler(router, config, { manager: true }));
    entry.use(managerPermissions);
  } else {
    // Bound the authentication work queue and attempt map; never trust forwarded IP headers.
    const attempts = new Map(); let activeHashes = 0;
    entry.use(['/setup', '/login'], (req, res, next) => {
      if (req.method !== 'POST') return next();
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
      const key = req.ip, entry = attempts.get(key) || { count: 0, until: now + 60000 };
      if (++entry.count > 10 || attempts.size >= 10000 || activeHashes >= 4) return next(new HttpError(429, 'rate_limit_exceeded', 'Too many attempts'));
      attempts.set(key, entry); next();
    });
    entry.get('/setup', async (req, res) => { const rows = await db.query('SELECT id FROM admins WHERE id=1'); res.json({ setup_required: !rows.length }); });
    entry.post('/setup', async (req, res) => {
      if (digest(req.get('x-bootstrap-token') || '') !== digest(config.bootstrapToken)) fail(403, 'invalid_bootstrap_token', 'Invalid bootstrap token');
      const data = fields(req.body, { password });
      activeHashes++;
      try { const hash = await hashPassword(data.password); await db.query('INSERT INTO admins(id,password_hash) VALUES (1,?)', [hash]); }
      finally { activeHashes--; }
      res.status(201).json({ initialized: true });
    });
    entry.post('/login', async (req, res) => {
      const data = fields(req.body, { password: value => text(value, 1024) });
      const [admin] = await db.query('SELECT password_hash FROM admins WHERE id=1');
      activeHashes++;
      let valid;
      try { valid = admin && await verifyPassword(data.password, admin.password_hash); } finally { activeHashes--; }
      if (!valid) fail(401, 'invalid_credentials', 'Invalid administrator credentials');
      const credential = token('adm_');
      await db.query('DELETE FROM admin_sessions WHERE expires_at <= UTC_TIMESTAMP(3)');
      await db.query('INSERT INTO admin_sessions(token_hash,expires_at) VALUES (?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 8 HOUR))', [digest(credential)]);
      res.json({ token: credential, expires_in: 28800 });
    });
    const authenticate = adminSession(db);
    entry.all('/mcp', mcpAuthentication(db, 'ADMIN', authenticate), mcpHandler(router, config));
    entry.use(authenticate);
  }
  entry.use(mcpTokensRouter(db));
  if (!manager) router.use(managerAccountsRouter(db));
  router.put('/proxy-keys/:id/expiry', async (req, res) => {
    const data = fields(req.body, { expires_at: proxyKeyExpiry });
    const result = await db.query('UPDATE proxy_api_keys SET expires_at=? WHERE id=?', [data.expires_at, id(req.params.id)]);
    if (!result.affectedRows) fail(404, 'not_found', 'Record not found');
    res.sendStatus(204);
  });
  router.patch('/proxy-keys/:id', async (req, res) => {
    const { name } = fields(req.body, { name: text });
    const result = await db.query('UPDATE proxy_api_keys SET name=? WHERE id=?', [name, id(req.params.id)]);
    if (!result.affectedRows) fail(404, 'not_found', 'Record not found');
    res.sendStatus(204);
  });
  router.get('/settings/debug-logging', async (req, res) => res.json({ enabled: await debugLoggingEnabled(db) }));
  router.put('/settings/debug-logging', async (req, res) => {
    const data = fields(req.body, { enabled: value => {
      if (typeof value !== 'boolean') fail(400, 'invalid_input', 'Enabled must be a boolean');
      return value;
    } });
    await db.query('UPDATE debug_logging_settings SET enabled=?,updated_at=UTC_TIMESTAMP(3) WHERE id=1', [data.enabled]);
    res.json(data);
  });
  router.post('/logout', async (req, res) => { await db.query('DELETE FROM admin_sessions WHERE token_hash=?', [req.sessionHash]); res.sendStatus(204); });
  router.put('/password', async (req, res) => {
    const data = fields(req.body, { current_password: value => text(value, 1024), password });
    const [admin] = await db.query('SELECT password_hash FROM admins WHERE id=1');
    if (!await verifyPassword(data.current_password, admin.password_hash)) fail(401, 'invalid_credentials', 'Invalid current password');
    const hash = await hashPassword(data.password);
    await db.transaction(async tx => { await tx.query('UPDATE admins SET password_hash=?,updated_at=UTC_TIMESTAMP(3) WHERE id=1', [hash]); await tx.query('DELETE FROM admin_sessions'); });
    res.sendStatus(204);
  });
  const status = value => choice(value, ['ACTIVE', 'DISABLED']);
  async function list(req, res, table, columns) {
    const after = req.query.after === undefined ? '0' : id(req.query.after);
    const params = [after];
    let membership = '';
    if (table === 'users' && req.query.group_id !== undefined) {
      const values = Array.isArray(req.query.group_id) ? req.query.group_id : [req.query.group_id];
      if (!values.length || values.length > 500 || values.some(value => typeof value !== 'string' || !/^[1-9]\d{0,18}$/.test(value))) fail(400, 'invalid_filter', 'Invalid group selection');
      const ids = [...new Set(values)];
      membership = ` AND EXISTS (SELECT 1 FROM user_groups g WHERE g.user_id=users.id AND g.group_id IN (${ids.map(() => '?').join(',')}))`;
      params.push(...ids);
    }
    const data = await db.query(`SELECT ${columns} FROM \`${table}\` WHERE id>?${membership} ORDER BY id LIMIT 500`, params);
    res.json({ data, next_after: data.length === 500 ? data.at(-1).id : null });
  }
  const resources = {
    users: { table: 'users', select: 'id,name,email,status,is_manager,created_at,updated_at', schema: { name: text, email: value => { text(value, 254); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(400, 'invalid_email', 'Invalid email'); return value; } }, update: { status: value => choice(value, ['ACTIVE', 'SUSPENDED']) } },
    groups: { table: 'groups', select: 'id,name,description,created_at,updated_at', schema: { name: text, description: value => value === undefined || value === null ? null : text(value, 10000) } },
    providers: { table: 'llm_inference_providers', select: 'id,name,api_url,anthropic_api_url,api_type,status,created_at,updated_at', schema: { name: text, api_url: providerUrl, anthropic_api_url: value => value == null ? null : providerUrl(value), api_type: value => value === undefined ? 'OPENAI_COMPATIBLE' : choice(value, ['OPENAI_COMPATIBLE', 'ANTHROPIC', 'GEMINI', 'AWS_BEDROCK', 'OPENAI_ANTHROPIC']) }, update: { status } }
  };
  for (const [path, spec] of Object.entries(resources)) {
    router.get(`/${path}`, async (req, res) => { await list(req, res, spec.table, manager && path === 'providers' ? 'id,name' : spec.select); });
    router.get(`/${path}/:id`, async (req, res) => { const [row] = await db.query(`SELECT ${spec.select} FROM \`${spec.table}\` WHERE id=?`, [id(req.params.id)]); if (!row) fail(404, 'not_found', 'Record not found'); res.json(row); });
    router.post(`/${path}`, async (req, res) => {
      const data = fields(req.body, spec.schema), keys = Object.keys(data);
      const result = await db.query(`INSERT INTO \`${spec.table}\` (${keys.map(k => `\`${k}\``).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(data));
      res.status(201).json({ id: result.insertId, ...data });
    });
    router.patch(`/${path}/:id`, async (req, res) => {
      const data = fields(req.body, { ...spec.schema, ...spec.update }, true);
      const result = await db.transaction(async tx => {
        if (path === 'providers' && data.api_type !== undefined) {
          const [provider] = await tx.query('SELECT api_type FROM llm_inference_providers WHERE id=? FOR UPDATE', [id(req.params.id)]);
          if (!provider) fail(404, 'not_found', 'Record not found');
          if (provider.api_type !== data.api_type && [provider.api_type, data.api_type].includes('AWS_BEDROCK')) {
            const keys = await tx.query('SELECT id FROM upstream_api_keys WHERE provider_id=? LIMIT 1', [id(req.params.id)]);
            if (keys.length) fail(409, 'provider_has_keys', 'Create a separate provider when switching existing keys to or from AWS Bedrock');
          }
        }
        if (path === 'users' && data.status === 'SUSPENDED') {
          await tx.query('UPDATE users SET manager_auth_version=manager_auth_version+1 WHERE id=?', [id(req.params.id)]);
          await revokeManagerTokens(tx, id(req.params.id));
          await tx.query('DELETE FROM manager_sessions WHERE user_id=?', [id(req.params.id)]);
        }
        return tx.query(`UPDATE \`${spec.table}\` SET ${Object.keys(data).map(k => `\`${k}\`=?`).join(',')},updated_at=UTC_TIMESTAMP(3) WHERE id=?`, [...Object.values(data), id(req.params.id)]);
      });
      if (!result.affectedRows) fail(404, 'not_found', 'Record not found'); res.sendStatus(204);
    });
  }
  router.get('/groups/:id/users', async (req, res) => res.json({ data: await db.query('SELECT u.id,u.name,u.email,u.status FROM users u JOIN user_groups g ON g.user_id=u.id WHERE g.group_id=? ORDER BY u.id LIMIT 500', [id(req.params.id)]) }));
  router.put('/groups/:group/users/:user', async (req, res) => { await db.query('INSERT INTO user_groups(group_id,user_id) VALUES (?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id)', [id(req.params.group), id(req.params.user)]); res.sendStatus(204); });
  router.delete('/groups/:group/users/:user', async (req, res) => { await db.query('DELETE FROM user_groups WHERE group_id=? AND user_id=?', [id(req.params.group), id(req.params.user)]); res.sendStatus(204); });
  router.get('/provider-options', (req, res) => res.json({ bedrock_regions: BEDROCK_REGIONS }));
  router.get('/upstream-keys', async (req, res) => list(req, res, 'upstream_api_keys', manager ? 'id,name' : 'id,provider_id,name,key_fingerprint,status,aws_region,request_compression_c,request_compression_r,request_compression_m,created_at,updated_at,last_used_at'));
  router.post('/upstream-keys/:id/check', async (req, res) => {
    const [assignment] = await db.query('SELECT k.encrypted_api_key,k.aws_region,k.request_compression_c,k.request_compression_r,k.request_compression_m,p.api_url,p.api_type FROM upstream_api_keys k JOIN llm_inference_providers p ON p.id=k.provider_id WHERE k.id=?', [id(req.params.id)]);
    if (!assignment) fail(404, 'not_found', 'Record not found');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    try {
      const result = await checkUpstreamKey(assignment, config, { fetchImpl: dependencies.fetchImpl, signal: controller.signal });
      if (!res.destroyed) res.json(result);
    } finally { res.off('close', abort); }
  });
  router.post('/upstream-keys/:id/check-compression', async (req, res) => {
    const [assignment] = await db.query('SELECT k.id,k.encrypted_api_key,k.aws_region,p.api_url,p.anthropic_api_url,p.api_type FROM upstream_api_keys k JOIN llm_inference_providers p ON p.id=k.provider_id WHERE k.id=?', [id(req.params.id)]);
    if (!assignment) fail(404, 'not_found', 'Record not found');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    try {
      let values;
      try { values = await checkUpstreamCompression(assignment, config, { fetchImpl: dependencies.fetchImpl, signal: controller.signal }); }
      catch { fail(502, 'compression_check_failed', 'Could not determine compression support. Check the upstream credential and try again.'); }
      await db.query('UPDATE upstream_api_keys SET request_compression_c=?,request_compression_r=?,request_compression_m=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [values.request_compression_c, values.request_compression_r, values.request_compression_m, assignment.id]);
      if (!res.destroyed) res.json(values);
    } finally { res.off('close', abort); }
  });
  router.get('/upstream-keys/:id/models', async (req, res) => {
    const [assignment] = await db.query('SELECT k.encrypted_api_key,k.aws_region,k.request_compression_c,k.request_compression_r,k.request_compression_m,p.api_url,p.api_type FROM upstream_api_keys k JOIN llm_inference_providers p ON p.id=k.provider_id WHERE k.id=?', [id(req.params.id)]);
    if (!assignment) fail(404, 'not_found', 'Record not found');
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.on('close', abort);
    try {
      const result = await listUpstreamModels(assignment, config, { fetchImpl: dependencies.fetchImpl, signal: controller.signal });
      if (!res.destroyed) res.json(result);
    } finally { res.off('close', abort); }
  });
  router.post('/upstream-keys', async (req, res) => {
    const compression = value => value === undefined ? 'NONE' : choice(value, ['NONE', 'GZIP', 'ZSTD']);
    const data = fields(req.body, { provider_id: id, name: text, api_key: validateUpstreamCredential, aws_region: value => value === undefined || value === null ? null : validateRegion(value), request_compression_c: compression, request_compression_r: compression, request_compression_m: compression });
    const fingerprint = digest(data.api_key).slice(0, 16);
    const encrypted = encrypt(data.api_key, config.encryptionKey);
    const result = await db.transaction(async tx => {
      const [provider] = await tx.query('SELECT api_type FROM llm_inference_providers WHERE id=? FOR UPDATE', [data.provider_id]);
      if (!provider) fail(409, 'provider_not_found', 'Provider not found');
      if (provider.api_type === 'AWS_BEDROCK') validateRegion(data.aws_region);
      else if (data.aws_region !== null) fail(400, 'unexpected_aws_region', 'AWS region applies only to Bedrock keys');
      return tx.query('INSERT INTO upstream_api_keys(provider_id,name,encrypted_api_key,key_fingerprint,aws_region,request_compression_c,request_compression_r,request_compression_m) VALUES (?,?,?,?,?,?,?,?)', [data.provider_id, data.name, encrypted, fingerprint, data.aws_region, data.request_compression_c, data.request_compression_r, data.request_compression_m]);
    });
    res.status(201).json({ id: result.insertId, name: data.name, key_fingerprint: fingerprint, aws_region: data.aws_region, request_compression_c: data.request_compression_c, request_compression_r: data.request_compression_r, request_compression_m: data.request_compression_m });
  });
  router.get('/proxy-keys', async (req, res) => list(req, res, 'proxy_api_keys', 'id,user_id,name,key_prefix,role_id,status,expires_at,created_at,revoked_at,last_used_at'));
  router.post('/proxy-keys', async (req, res) => {
    const data = fields(req.body, { user_id: id, name: text, role_id: value => value == null ? null : id(value), expires_at: value => proxyKeyExpiry(value === undefined ? null : value) }), key = token('pak_');
    const result = await db.transaction(async tx => {
      await checkManagerRole(tx, req.manager, data.role_id);
      return tx.query('INSERT INTO proxy_api_keys(user_id,name,key_hash,key_prefix,expires_at,role_id) VALUES (?,?,?,?,?,?)',
        [data.user_id, data.name, digest(key), key.slice(0, 12), data.expires_at, data.role_id]);
    });
    res.status(201).json({ id: result.insertId, ...data, api_key: key, key_prefix: key.slice(0, 12) });
  });
  router.patch('/upstream-keys/:id', async (req, res) => {
    const data = fields(req.body, { name: text, status, aws_region: validateRegion, api_key: validateUpstreamCredential, request_compression_c: value => choice(value, ['NONE', 'GZIP', 'ZSTD']), request_compression_r: value => choice(value, ['NONE', 'GZIP', 'ZSTD']), request_compression_m: value => choice(value, ['NONE', 'GZIP', 'ZSTD']) }, true);
    if (data.api_key !== undefined) {
      data.encrypted_api_key = encrypt(data.api_key, config.encryptionKey);
      data.key_fingerprint = digest(data.api_key).slice(0, 16);
      delete data.api_key;
    }
    const keyId = id(req.params.id);
    const result = await db.transaction(async tx => {
      const [key] = await tx.query('SELECT k.id,p.api_type FROM upstream_api_keys k JOIN llm_inference_providers p ON p.id=k.provider_id WHERE k.id=? FOR UPDATE', [keyId]);
      if (!key) fail(404, 'not_found', 'Record not found');
      if (data.aws_region !== undefined && key.api_type !== 'AWS_BEDROCK') fail(400, 'unexpected_aws_region', 'AWS region applies only to Bedrock keys');
      return tx.query(`UPDATE upstream_api_keys SET ${Object.keys(data).map(k => `${k}=?`).join(',')},updated_at=UTC_TIMESTAMP(3) WHERE id=?`, [...Object.values(data), keyId]);
    });
    if (!result.affectedRows) fail(404, 'not_found', 'Record not found'); res.sendStatus(204);
  });
  router.post('/proxy-keys/:id/revoke', async (req, res) => { const result = await db.query("UPDATE proxy_api_keys SET status='REVOKED',revoked_at=COALESCE(revoked_at,UTC_TIMESTAMP(3)) WHERE id=?", [id(req.params.id)]); if (!result.affectedRows) fail(404, 'not_found', 'Record not found'); res.sendStatus(204); });
  router.use(rolesRouter(db, config, dependencies));
  router.use(usageLimitsRouter(db));
  router.use(userViewingKeysRouter(db));
  router.use(modelPoliciesRouter(db));
  router.use(modelAliasesRouter(db));
  router.use(classificationHandlersRouter(db, config));
  router.use(pricingRouter(db, dependencies));
  if (!manager) router.use(usageMaintenanceRouter(db));
  router.use(reportsRouter(db));
  entry.use(router);
  return entry;
}
