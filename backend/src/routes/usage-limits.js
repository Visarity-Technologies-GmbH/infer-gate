import { Router } from 'express';
import { fail } from '../errors.js';
import { usageLimitStatus, validateUsageLimit } from '../services/usage-limits.js';

export function usageLimitsRouter(db) {
  const router = Router();
  const userId = req => {
    if (!/^[1-9]\d{0,18}$/.test(req.params.id)) fail(400, 'invalid_id', 'Invalid identifier');
    return req.params.id;
  };
  router.get('/users/:id/usage-limit', async (req, res) => {
    const id = userId(req);
    const [user] = await db.query('SELECT id FROM users WHERE id=?', [id]);
    if (!user) fail(404, 'not_found', 'User not found');
    res.json(await usageLimitStatus(db, id));
  });
  router.put('/users/:id/usage-limit', async (req, res) => {
    const id = userId(req), limit = validateUsageLimit(req.body);
    await db.transaction(async tx => {
      const [user] = await tx.query('SELECT id FROM users WHERE id=? FOR UPDATE', [id]);
      if (!user) fail(404, 'not_found', 'User not found');
      await tx.query(`INSERT INTO user_usage_limits(user_id,enabled,period,basis,token_limit,cost_limit)
        VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE enabled=VALUES(enabled),period=VALUES(period),basis=VALUES(basis),
        token_limit=VALUES(token_limit),cost_limit=VALUES(cost_limit),updated_at=UTC_TIMESTAMP(3)`,
      [id, limit.enabled, limit.period, limit.basis, limit.token_limit, limit.cost_limit]);
    });
    res.sendStatus(204);
  });
  return router;
}
