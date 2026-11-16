import { Router } from 'express';
import { digest, token } from '../security/credentials.js';
import { fail } from '../errors.js';
import { userUsage } from '../services/user-usage.js';

export function userUsageRouter(db) {
  const router = Router();
  router.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/usage', async (req, res) => {
    const match = /^Bearer (uvk_[A-Za-z0-9_-]{43})$/i.exec(req.get('authorization') || '');
    if (!match) fail(401, 'invalid_viewing_key', 'This usage link is invalid or no longer available. Ask your administrator for a new link.');
    const [user] = await db.query(`SELECT u.id,u.name,u.email FROM user_viewing_keys k
      JOIN users u ON u.id=k.user_id WHERE k.key_hash=? AND u.status='ACTIVE'`, [digest(match[1])]);
    if (!user) fail(401, 'invalid_viewing_key', 'This usage link is invalid or no longer available. Ask your administrator for a new link.');
    if (Object.keys(req.query).length) fail(400, 'invalid_filter', 'This page only supports your current usage.');
    res.json({ ...await userUsage(db, user.id), user: { name: user.name, email: user.email } });
  });
  return router;
}

// Mounted behind authorized administrator or manager session authentication.
export function userViewingKeysRouter(db) {
  const router = Router();
  const userId = req => {
    if (!/^[1-9]\d{0,18}$/.test(req.params.id)) fail(400, 'invalid_id', 'Invalid identifier');
    return req.params.id;
  };
  router.get('/users/:id/viewing-key', async (req, res) => {
    const id = userId(req);
    const [user] = await db.query('SELECT id FROM users WHERE id=?', [id]);
    if (!user) fail(404, 'not_found', 'User not found');
    const [key] = await db.query('SELECT created_at FROM user_viewing_keys WHERE user_id=?', [id]);
    res.json({ exists: !!key, created_at: key?.created_at ?? null });
  });
  router.post('/users/:id/viewing-key', async (req, res) => {
    const id = userId(req);
    if (req.body != null && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length))
      fail(400, 'invalid_fields', 'No fields are accepted');
    const key = token('uvk_');
    await db.transaction(async tx => {
      const [user] = await tx.query('SELECT id FROM users WHERE id=? FOR UPDATE', [id]);
      if (!user) fail(404, 'not_found', 'User not found');
      await tx.query(`INSERT INTO user_viewing_keys(user_id,key_hash) VALUES (?,?)
        ON DUPLICATE KEY UPDATE key_hash=VALUES(key_hash),created_at=UTC_TIMESTAMP(3)`, [id, digest(key)]);
    });
    res.status(201).json({ key });
  });
  return router;
}
