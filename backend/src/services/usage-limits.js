import { HttpError, fail } from '../errors.js';

export function periodBounds(period, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'WEEKLY') start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + (period === 'WEEKLY' ? 7 : 1));
  return { start, end };
}

// Exact decimal parsing: limits never pass through floating point arithmetic.
export function decimalUnits(value, scale, max) {
  if (typeof value !== 'string' || !new RegExp(`^\\d{1,18}(?:\\.\\d{1,${scale}})?$`).test(value))
    fail(400, 'invalid_usage_limit', `Enter a positive decimal with at most ${scale} decimal places`);
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole + fraction.padEnd(scale, '0'));
  if (result <= 0n || result > max) fail(400, 'invalid_usage_limit', 'Usage limit is outside the supported range');
  return result;
}
export function formatUnits(value, scale) {
  const text = BigInt(value).toString().padStart(scale + 1, '0');
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}
function storedUnits(value, scale) {
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole + fraction.padEnd(scale, '0'));
}
export function validateUsageLimit(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !['enabled', 'period', 'basis', 'amount'].includes(key)) ||
      typeof body.enabled !== 'boolean' || !['DAILY', 'WEEKLY'].includes(body.period) || !['TOKENS', 'COST'].includes(body.basis))
    fail(400, 'invalid_usage_limit', 'Supply enabled, period, basis and amount');
  const tokens = body.basis === 'TOKENS';
  const units = decimalUnits(body.amount, tokens ? 6 : 12, tokens ? 18446744073709551615n : 10n ** 30n - 1n);
  return { enabled: body.enabled, period: body.period, basis: body.basis,
    token_limit: tokens ? units.toString() : null, cost_limit: tokens ? null : formatUnits(units, 12) };
}

export async function usageLimitStatus(db, userId, { now = new Date() } = {}) {
  const [limit] = await db.query('SELECT * FROM user_usage_limits WHERE user_id=?', [userId]);
  if (!limit) return { enabled: false };
  const tokens = limit.basis === 'TOKENS';
  const result = { enabled: !!limit.enabled, period: limit.period, basis: limit.basis,
    amount: tokens ? formatUnits(limit.token_limit, 6) : limit.cost_limit };
  if (!limit.enabled) return result;
  const { start, end } = periodBounds(limit.period, now);
  // Successful and cancelled requests with usable consumption contribute to caps.
  // Missing consumption/prices remain NULL in accounting and count as zero here.
  const [usage] = await db.query(`SELECT
    COALESCE(SUM(${tokens ? 'e.total_tokens' : `CASE
      WHEN e.input_tokens IS NULL OR e.output_tokens IS NULL THEN 0
      WHEN c.status='COMPLETE' THEN c.known_cost
      WHEN c.status='PARTIAL'
        AND (c.reason IS NULL OR c.reason<>'Invalid cache token breakdown')
        AND (e.cache_write_input_tokens IS NOT NULL OR c.cache_write_cost IS NOT NULL)
        THEN c.known_cost
      ELSE 0 END`}),0) AS consumed
    FROM usage_events e LEFT JOIN usage_costs c ON c.usage_event_id=e.id
    WHERE e.user_id=? AND e.timestamp>=? AND e.timestamp<? AND e.request_status IN ('SUCCESS','CANCELLED')`, [userId, start, end]);
  const consumed = tokens ? BigInt(usage.consumed) : storedUnits(usage.consumed, 12);
  const configured = tokens ? BigInt(limit.token_limit) : storedUnits(limit.cost_limit, 12);
  return { ...result, consumed: tokens ? formatUnits(consumed, 6) : formatUnits(consumed, 12),
    cutoff: tokens ? formatUnits(configured * 95n, 8) : formatUnits((configured * 95n + 99n) / 100n, 12),
    period_start: start.toISOString(), resets_at: end.toISOString(),
    blocked: consumed * 100n >= configured * 95n,
    block_reason: consumed * 100n >= configured * 95n ? 'user_usage_limit_reached' : null };
}

export async function enforceUsageLimit(db, userId, options) {
  const status = await usageLimitStatus(db, userId, options);
  if (!status.blocked) return;
  const message = `Your ${status.period.toLowerCase()} ${status.basis === 'TOKENS' ? 'token' : 'cost'} usage limit has been reached. Access resumes at ${status.resets_at}.`;
  const error = new HttpError(429, status.block_reason, message);
  error.type = 'usage_limit_error';
  error.retryAfter = Math.max(1, Math.ceil((new Date(status.resets_at) - (options?.now || new Date())) / 1000));
  throw error;
}
