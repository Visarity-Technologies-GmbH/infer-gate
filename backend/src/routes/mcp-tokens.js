import { Router } from 'express';
import { fail } from '../errors.js';
import { token, digest } from '../security/credentials.js';

export function mcpAuthentication(db, scope, session) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    if (!header.startsWith('Bearer mcp_')) return session(req, res, next);
    const match = /^Bearer (mcp_[A-Za-z0-9_-]{43})$/.exec(header);
    if (!match) fail(401, 'invalid_mcp_token', 'Invalid MCP token');
    const [row] = await db.query(`SELECT t.id,t.scope,t.manager_id FROM mcp_access_tokens t
      LEFT JOIN users u ON u.id=t.manager_id
      WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>UTC_TIMESTAMP(3)
      AND (t.manager_id IS NULL OR (t.scope IN ('REPORT','MANAGER') AND u.is_manager=TRUE AND u.status='ACTIVE' AND u.manager_password_temporary=FALSE))`, [digest(match[1])]);
    if (!row) fail(401, 'invalid_mcp_token', 'Invalid or expired MCP token');
    if (row.scope !== scope) fail(403, 'mcp_scope_required', 'MCP token scope does not permit this endpoint');
    if (scope === 'MANAGER') {
      if (!row.manager_id) fail(403, 'manager_permission_denied', 'Manager-owned token required');
      req.manager = { id: row.manager_id };
    }
    await db.query('UPDATE mcp_access_tokens SET last_used_at=UTC_TIMESTAMP(3) WHERE id=?', [row.id]);
    next();
  };
}

export function revokeManagerTokens(tx, managerId) {
  return tx.query('UPDATE mcp_access_tokens SET revoked_at=UTC_TIMESTAMP(3) WHERE manager_id=? AND revoked_at IS NULL', [managerId]);
}

function expiry(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'invalid_expiry', 'Supply a valid UTC date');
  const date = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day)
    fail(400, 'invalid_expiry', 'Supply a valid UTC date');
  date.setUTCDate(date.getUTCDate() + 1);
  if (date.getTime() <= Date.now() || date.getUTCFullYear() > 9999)
    fail(400, 'invalid_expiry', 'Choose an expiry date of today or later');
  return date;
}

export function mcpTokensRouter(db) {
  const router = Router();
  router.get('/mcp-tokens', async (req, res) => {
    const after = req.query.after ?? '0';
    if (typeof after !== 'string' || !/^\d{1,19}$/.test(after)) fail(400, 'invalid_id', 'Invalid cursor');
    const rows = await db.query(`SELECT t.id,t.name,t.scope,t.token_prefix,t.manager_id,u.name AS manager_name,
      t.created_at,t.expires_at,t.last_used_at,t.revoked_at,CASE WHEN t.revoked_at IS NOT NULL THEN 'REVOKED'
      WHEN t.expires_at<=UTC_TIMESTAMP(3) THEN 'EXPIRED' ELSE 'ACTIVE' END AS status
      FROM mcp_access_tokens t LEFT JOIN users u ON u.id=t.manager_id
      WHERE t.id>? ${req.manager ? 'AND t.manager_id=?' : ''} ORDER BY t.id LIMIT 500`, req.manager ? [after, req.manager.id] : [after]);
    res.json({ data: rows, next_after: rows.length === 500 ? rows.at(-1).id : null });
  });
  router.post('/mcp-tokens', async (req, res) => {
    const body = req.body;
    if (!body || Object.keys(body).some(key => !['name','scope','valid_through'].includes(key)) ||
        typeof body.name !== 'string' || !body.name.trim() || body.name.length > 255)
      fail(400, 'invalid_input', 'Supply a token name and UTC expiry date');
    const scope = body.scope === undefined ? 'REPORT' : body.scope;
    if (!['REPORT','ADMIN','MANAGER'].includes(scope)) fail(400, 'invalid_scope', 'Invalid MCP scope');
    if (req.manager && scope === 'ADMIN') fail(403, 'manager_permission_denied', 'Administrator access required');
    if (!req.manager && scope === 'MANAGER') fail(403, 'manager_permission_denied', 'Sign in as a manager to issue a manager token');
    const expires = expiry(body.valid_through);
    const credential = token('mcp_');
    const result = await db.transaction(async tx => {
      if (req.manager) {
        // Serialize issuance with suspension and demotion, including a demote/re-promote race.
        const rows = await tx.query(`SELECT id FROM users WHERE id=? AND is_manager=TRUE AND status='ACTIVE'
          AND manager_password_temporary=FALSE AND manager_auth_version=? FOR UPDATE`, [req.manager.id, req.manager.manager_auth_version]);
        if (!rows.length) fail(403, 'manager_permission_denied', 'Manager access has changed');
      }
      return tx.query('INSERT INTO mcp_access_tokens(manager_id,name,scope,token_hash,token_prefix,expires_at) VALUES (?,?,?,?,?,?)',
        [req.manager?.id ?? null, body.name.trim(), scope, digest(credential), credential.slice(0,12), expires]);
    });
    res.status(201).json({ id: result.insertId, token: credential, scope, expires_at: expires });
  });
  router.patch('/mcp-tokens/:id', async (req, res) => {
    const { id } = req.params;
    if (!/^[1-9]\d{0,18}$/.test(id)) fail(400, 'invalid_id', 'Invalid token ID');
    const name = req.body?.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || Object.keys(req.body).length !== 1)
      fail(400, 'invalid_input', 'Supply a token name of up to 255 characters');
    const result = await db.query(`UPDATE mcp_access_tokens SET name=? WHERE id=? ${req.manager ? 'AND manager_id=?' : ''}`,
      req.manager ? [name.trim(), id, req.manager.id] : [name.trim(), id]);
    if (!result.affectedRows) fail(404, 'not_found', 'Token not found');
    res.sendStatus(204);
  });
  router.post('/mcp-tokens/:id/revoke', async (req, res) => {
    if (!/^[1-9]\d{0,18}$/.test(req.params.id)) fail(400, 'invalid_id', 'Invalid token ID');
    const result = await db.query(`UPDATE mcp_access_tokens SET revoked_at=COALESCE(revoked_at,UTC_TIMESTAMP(3))
      WHERE id=? ${req.manager ? 'AND manager_id=?' : ''}`, req.manager ? [req.params.id, req.manager.id] : [req.params.id]);
    if (!result.affectedRows) fail(404, 'not_found', 'Token not found');
    res.sendStatus(204);
  });
  return router;
}
