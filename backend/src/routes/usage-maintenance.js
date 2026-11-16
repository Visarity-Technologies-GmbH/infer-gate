import { Router } from 'express';
import { fail } from '../errors.js';
import { maintainUsage } from '../services/usage-maintenance.js';

function timestamp(value) {
  // Require a real UTC calendar date; reject local time, offsets and normalized dates.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(value))
    fail(400, 'invalid_interval', 'Use a UTC date (YYYY-MM-DD) or timestamp (YYYY-MM-DDTHH:mm:ss[.sss]Z)');
  const date = new Date(value);
  const normalized = value.length === 10 ? `${value}T00:00:00.000Z` : value.replace(/(?<=:\d{2})Z$/, '.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized || date.getUTCFullYear() < 1000)
    fail(400, 'invalid_interval', 'Invalid UTC date or timestamp');
  return date;
}
function fields(body, names) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !names.includes(key)) || names.some(key => !Object.hasOwn(body, key)))
    fail(400, 'invalid_input', `Supply only ${names.join(', ')}`);
  return Object.fromEntries(names.map(key => [key, timestamp(body[key])]));
}
export function usageMaintenanceRouter(db) {
  const router = Router();
  function handler(names) {
    return async (req, res) => {
      const dates = fields(req.body, names);
      if (dates.start && dates.start >= dates.end) fail(400, 'invalid_interval', 'Start must precede end');
      try {
        const result = await maintainUsage(db, { ...dates, cancelled: () => res.destroyed });
        res.json(result);
      } catch (error) {
        if (!error.maintenanceProgress) throw error;
        res.status(500).json({ error: { code: 'usage_maintenance_failed', type: 'server_error',
          message: 'Maintenance failed; earlier batches may have committed. Retry the same interval.', param: null },
        ...error.maintenanceProgress });
      }
    };
  }
  router.delete('/usage/events', handler(['before']));
  router.post('/usage/recalculate-costs', handler(['start', 'end']));
  return router;
}
