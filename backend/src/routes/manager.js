import { mcpAuthentication, revokeManagerTokens } from './mcp-tokens.js';
import { Router, json } from 'express';
import { digest, token, hashPassword, verifyPassword } from '../security/credentials.js';
import { fail, HttpError } from '../errors.js';

// Share a bounded password-work queue across manager login, changes and admin resets.
let activeHashes = 0;
async function passwordWork(work) {
  if (activeHashes >= 4) fail(429, 'rate_limit_exceeded', 'Too many attempts');
  activeHashes++;
  try { return await work(); } finally { activeHashes--; }
}
function bodyFields(body, names) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !names.includes(key)))
    fail(400, 'invalid_input', 'Invalid fields');
}
function password(value, minimum = 1) {
  if (typeof value !== 'string' || value.length < minimum || value.length > 1024)
    fail(400, 'invalid_input', minimum === 1 ? 'Supply a password of at most 1024 characters' : 'Password must contain 12 to 1024 characters');
  return value;
}
const accountColumns = `id,name,email,status,is_manager,password_hash,manager_auth_version,
  manager_password_temporary,manager_password_expires_at,
  (manager_password_expires_at > UTC_TIMESTAMP(3)) AS temporary_valid`;
const usable = user => user && user.status === 'ACTIVE' && user.is_manager && user.password_hash &&
  (!user.manager_password_temporary || user.temporary_valid);

export function managerSession(db) {
  return async (req, res, next) => {

    const match = /^Bearer (mgr_[A-Za-z0-9_-]{43})$/.exec(req.get('authorization') || '');
    if (!match) fail(401, 'manager_auth_required', 'Manager authentication required');
    const [user] = await db.query(`SELECT u.id,u.name,u.email,u.manager_password_temporary,u.manager_auth_version
      FROM manager_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at > UTC_TIMESTAMP(3) AND s.auth_version=u.manager_auth_version
      AND u.status='ACTIVE' AND u.is_manager=TRUE
      AND (u.manager_password_temporary=FALSE OR u.manager_password_expires_at > UTC_TIMESTAMP(3))`, [digest(match[1])]);
    if (!user) fail(401, 'invalid_session', 'Manager session expired or invalid');
    req.manager = user; req.sessionHash = digest(match[1]);
    if (user.manager_password_temporary && !/^\/(password|logout|session)\/?$/i.test(req.path))
      fail(403, 'password_change_required', 'Change your temporary password before continuing');
    next();
  };
}

export function managerAuthRouter(db) {
  const router = Router();
  router.use(json({ limit: '64kb' }));
  router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const attempts = new Map();
  router.use(['/login', '/password'], (req, res, next) => {
    if (!['POST', 'PUT'].includes(req.method)) return next();
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
    const entry = attempts.get(req.ip) || { count: 0, until: now + 60000 };
    if (++entry.count > 10 || attempts.size >= 10000) return next(new HttpError(429, 'rate_limit_exceeded', 'Too many attempts'));
    attempts.set(req.ip, entry); next();
  });
  router.post('/login', async (req, res) => {
    bodyFields(req.body, ['email', 'password']);
    const input = password(req.body.password);
    if (typeof req.body.email !== 'string' || !req.body.email.trim() || req.body.email.length > 254)
      fail(400, 'invalid_input', 'Supply your email address');
    const [user] = await db.query(`SELECT ${accountColumns} FROM users WHERE email=?`, [req.body.email.trim()]);
    // A valid dummy hash keeps unknown/non-manager logins on the password-work path.
    const dummyHash = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
    const valid = await passwordWork(() => verifyPassword(input, usable(user) ? user.password_hash : dummyHash));
    if (!valid || !usable(user)) fail(401, 'invalid_credentials', 'Invalid manager credentials');
    const credential = token('mgr_');
    await db.transaction(async tx => {
      const [current] = await tx.query(`SELECT ${accountColumns} FROM users WHERE id=? FOR UPDATE`, [user.id]);
      if (!usable(current) || current.password_hash !== user.password_hash || String(current.manager_auth_version) !== String(user.manager_auth_version))
        fail(401, 'invalid_credentials', 'Invalid manager credentials');
      await tx.query('DELETE FROM manager_sessions WHERE expires_at <= UTC_TIMESTAMP(3)');
      await tx.query(`INSERT INTO manager_sessions(token_hash,user_id,auth_version,expires_at)
        VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 8 HOUR))`, [digest(credential), user.id, current.manager_auth_version]);
    });
    res.json({ token: credential, expires_in: 28800, password_change_required: !!user.manager_password_temporary,
      user: { id: user.id, name: user.name, email: user.email } });
  });
  const authenticate = managerSession(db);
  router.all('/mcp', mcpAuthentication(db, 'MANAGER', authenticate), (req, res, next) => next('router'));
  router.use(authenticate);
  router.get('/session', (req, res) => res.json({ user: { id: req.manager.id, name: req.manager.name, email: req.manager.email },
    password_change_required: !!req.manager.manager_password_temporary }));
  router.post('/logout', async (req, res) => {
    await db.query('DELETE FROM manager_sessions WHERE token_hash=?', [req.sessionHash]); res.sendStatus(204);
  });
  router.put('/password', async (req, res) => {
    bodyFields(req.body, ['current_password', 'password']);
    const currentPassword = password(req.body.current_password), nextPassword = password(req.body.password, 12);
    if (currentPassword === nextPassword) fail(400, 'invalid_input', 'Choose a different new password');
    const [user] = await db.query(`SELECT ${accountColumns} FROM users WHERE id=?`, [req.manager.id]);
    const hash = await passwordWork(async () => {
      if (!usable(user) || !await verifyPassword(currentPassword, user.password_hash))
        fail(401, 'invalid_credentials', 'Invalid current password');
      return hashPassword(nextPassword);
    });
    await db.transaction(async tx => {
      const [current] = await tx.query(`SELECT ${accountColumns} FROM users WHERE id=? FOR UPDATE`, [user.id]);
      if (!usable(current) || current.password_hash !== user.password_hash || String(current.manager_auth_version) !== String(req.manager.manager_auth_version))
        fail(401, 'invalid_session', 'Manager session expired or invalid');
      await tx.query(`UPDATE users SET password_hash=?,manager_password_temporary=FALSE,manager_password_expires_at=NULL,
        manager_auth_version=manager_auth_version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?`, [hash, user.id]);
      await tx.query('DELETE FROM manager_sessions WHERE user_id=?', [user.id]);
    });
    res.sendStatus(204);
  });
  return router;
}

// A method-and-path allowlist protects shared handlers, including future routes.
export function managerPermissions(req, res, next) {
  const rules = {
    GET: [/^\/mcp-tokens\/?$/i, /^\/(dashboard|usage|usage\/models|usage\/categories|requests|users|groups|proxy-keys|roles|providers|upstream-keys)\/?$/i,
      /^\/(users|groups)\/[1-9]\d{0,18}\/?$/i,
      /^\/users\/[1-9]\d{0,18}\/(usage-limit|viewing-key)\/?$/i,
      /^\/groups\/[1-9]\d{0,18}\/users\/?$/i,
      /^\/proxy-keys\/[1-9]\d{0,18}\/role\/?$/i],
    POST: [/^\/mcp-tokens(?:\/[1-9]\d{0,18}\/revoke)?\/?$/i, /^\/(users|groups|proxy-keys)\/?$/i,
      /^\/users\/[1-9]\d{0,18}\/viewing-key\/?$/i,
      /^\/proxy-keys\/[1-9]\d{0,18}\/revoke\/?$/i],
    PATCH: [/^\/(users|groups|mcp-tokens)\/[1-9]\d{0,18}\/?$/i],
    PUT: [/^\/groups\/[1-9]\d{0,18}\/users\/[1-9]\d{0,18}\/?$/i,
      /^\/users\/[1-9]\d{0,18}\/usage-limit\/?$/i,
      /^\/proxy-keys\/[1-9]\d{0,18}\/(role|expiry)\/?$/i],
    DELETE: [/^\/groups\/[1-9]\d{0,18}\/users\/[1-9]\d{0,18}\/?$/i],
  };
  if (!req.manager || !(rules[req.method] || []).some(rule => rule.test(req.path)))
    fail(403, 'manager_permission_denied', 'This action requires administrator access');
  next();
}

// Mount only behind administrator authentication.
export function managerAccountsRouter(db) {
  const router = Router();
  router.put('/users/:id/manager', async (req, res) => {
    if (!/^[1-9]\d{0,18}$/.test(req.params.id)) fail(400, 'invalid_id', 'Invalid identifier');
    bodyFields(req.body, ['enabled', 'reset_password']);
    if (typeof req.body.enabled !== 'boolean' || (req.body.reset_password !== undefined && typeof req.body.reset_password !== 'boolean') || (!req.body.enabled && req.body.reset_password))
      fail(400, 'invalid_input', 'Supply enabled and optionally reset_password');
    const temporary = req.body.enabled ? token('') : null;
    const hash = temporary ? await passwordWork(() => hashPassword(temporary)) : null;
    let expiresAt;
    await db.transaction(async tx => {
      const [user] = await tx.query('SELECT id,is_manager,status FROM users WHERE id=? FOR UPDATE', [req.params.id]);
      if (!user) fail(404, 'not_found', 'User not found');
      if (req.body.enabled && user.status !== 'ACTIVE') fail(409, 'user_suspended', 'Reactivate the user before enabling manager access');
      if (req.body.enabled && user.is_manager && !req.body.reset_password) fail(409, 'already_manager', 'User already has manager access');
      if (req.body.reset_password && !user.is_manager) fail(409, 'not_manager', 'Promote the user before resetting their password');
      await tx.query(`UPDATE users SET is_manager=?,password_hash=?,manager_password_temporary=?,
        manager_password_expires_at=${temporary ? 'DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 24 HOUR)' : 'NULL'},
        manager_auth_version=manager_auth_version+1,updated_at=UTC_TIMESTAMP(3) WHERE id=?`, [req.body.enabled, hash, !!temporary, user.id]);
      await tx.query('DELETE FROM manager_sessions WHERE user_id=?', [user.id]);
      if (!req.body.enabled) await revokeManagerTokens(tx, user.id);
      if (temporary) {
        const [updated] = await tx.query('SELECT manager_password_expires_at FROM users WHERE id=?', [user.id]);
        expiresAt = updated.manager_password_expires_at;
      }
    });
    if (temporary) res.json({ temporary_password: temporary, expires_at: expiresAt });
    else res.sendStatus(204);
  });
  return router;
}
