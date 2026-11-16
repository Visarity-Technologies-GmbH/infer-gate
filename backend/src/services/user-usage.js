import { periodBounds, usageLimitStatus, formatUnits } from './usage-limits.js';

// Match cap units exactly: millions of tokens (8 decimal places) or USD (12).
export function remainingAllowance(limit) {
  if (!limit.enabled) return null;
  const scale = limit.basis === 'TOKENS' ? 8 : 12;
  const units = value => {
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(scale, '0'));
  };
  const remaining = units(limit.cutoff) - units(limit.consumed);
  return formatUnits(remaining > 0n ? remaining : 0n, scale);
}

export async function userUsage(db, userId, now = new Date()) {
  const { start, end } = periodBounds('DAILY', now);
  const [today] = await db.query(`SELECT COUNT(*) AS usage_events,
    SUM(input_tokens) AS input_tokens, COUNT(input_tokens) AS input_tokens_reported_events,
    SUM(output_tokens) AS output_tokens, COUNT(output_tokens) AS output_tokens_reported_events,
    SUM(total_tokens) AS total_tokens, COUNT(total_tokens) AS total_tokens_reported_events,
    COUNT(CASE WHEN c.status='COMPLETE' THEN 1 END) AS priced_events,
    COUNT(CASE WHEN c.status='PARTIAL' THEN 1 END) AS partial_events,
    COUNT(CASE WHEN c.status='UNSUPPORTED' THEN 1 END) AS unsupported_events,
    COUNT(CASE WHEN c.id IS NULL OR c.status='UNPRICED' THEN 1 END) AS unpriced_events
    FROM usage_events e LEFT JOIN usage_costs c ON c.usage_event_id=e.id
    WHERE e.user_id=? AND e.timestamp>=? AND e.timestamp<?`, [userId, start, end]);
  // Preserve exact DECIMAL sums and separate currencies, as in administrator reports.
  const costs = await db.query(`SELECT c.currency,SUM(CASE WHEN c.status='COMPLETE' THEN c.known_cost END) AS estimated_cost,SUM(c.known_cost) AS known_cost
    FROM usage_events e JOIN usage_costs c ON c.usage_event_id=e.id
    WHERE e.user_id=? AND e.timestamp>=? AND e.timestamp<?
    GROUP BY c.currency ORDER BY c.currency`, [userId, start, end]);
  // Fourteen UTC calendar days including today; keep unknown sums distinct
  // from dates with no events, which have a genuine zero consumption total.
  const activityStart = new Date(start);
  activityStart.setUTCDate(activityStart.getUTCDate() - 13);
  const daily = await db.query(`SELECT DATE_FORMAT(timestamp,'%Y-%m-%d') AS bucket,
    COUNT(*) AS usage_events,SUM(total_tokens) AS total_tokens,
    COUNT(total_tokens) AS total_tokens_reported_events
    FROM usage_events WHERE user_id=? AND timestamp>=? AND timestamp<?
    GROUP BY bucket ORDER BY bucket`, [userId, activityStart, end]);
  const byDay = new Map(daily.map(day => [day.bucket, day]));
  const days = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(activityStart);
    date.setUTCDate(date.getUTCDate() + index);
    const bucket = date.toISOString().slice(0, 10);
    return byDay.get(bucket) ?? { bucket, usage_events: 0, total_tokens: '0', total_tokens_reported_events: 0 };
  });
  const cap = await usageLimitStatus(db, userId, { now });
  return { today: { ...today, costs, start: start.toISOString(), end: end.toISOString() },
    activity: { start: activityStart.toISOString(), end: end.toISOString(), days },
    cap: { ...cap, remaining: remainingAllowance(cap) }, updated_at: now.toISOString() };
}
