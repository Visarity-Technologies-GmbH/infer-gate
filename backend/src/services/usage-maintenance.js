import { calculateCost } from './accounting.js';

const BATCH_SIZE = 100;

// Each batch commits independently. Capture a high-water mark so newly recorded events
// cannot extend a maintenance request indefinitely. IDs stay strings for BIGINT safety.
export async function maintainUsage(db, { before, start, end, cancelled = () => false }) {
  const deleting = before !== undefined;
  const result = deleting ? { deleted_events: 0, deleted_costs: 0, deleted_requests: 0 } : {
    recalculated_events: 0, skipped_unsupported: 0, skipped_missing_assessment: 0,
  };
  const [maximum] = await db.query('SELECT COALESCE(MAX(id),0) AS id FROM usage_events');
  const [requestMaximum] = deleting ? await db.query('SELECT COALESCE(MAX(id),0) AS id FROM api_requests') : [];
  let after = '0';
  try {
    while (!cancelled()) {
      const batch = await db.transaction(async tx => {
        const rows = await tx.query(`SELECT * FROM usage_events WHERE id>? AND id<=?
          AND timestamp${deleting ? '<?' : '>=? AND timestamp<?'} ORDER BY id LIMIT ${BATCH_SIZE} FOR UPDATE`,
        [after, String(maximum.id), ...(deleting ? [before] : [start, end])]);
        if (!rows.length) return null;
        const counts = Object.fromEntries(Object.keys(result).map(key => [key, 0]));
        if (deleting) {
          const ids = rows.map(row => String(row.id));
          const placeholders = ids.map(() => '?').join(',');
          counts.deleted_costs = (await tx.query(`DELETE FROM usage_costs WHERE usage_event_id IN (${placeholders})`, ids)).affectedRows;
          counts.deleted_events = (await tx.query(`DELETE FROM usage_events WHERE id IN (${placeholders})`, ids)).affectedRows;
        } else {
          for (const event of rows) {
            const [assessment] = await tx.query('SELECT id,status FROM usage_costs WHERE usage_event_id=? FOR UPDATE', [event.id]);
            if (!assessment) { counts.skipped_missing_assessment++; continue; }
            // Request bodies and provider-specific billing flags are not retained.
            // Never reinterpret a previously unsupported workload as standard tokens.
            if (assessment.status === 'UNSUPPORTED') { counts.skipped_unsupported++; continue; }
            const [request] = await tx.query(`SELECT r.started_at,r.endpoint,p.api_type FROM api_requests r
              LEFT JOIN llm_inference_providers p ON p.id=? WHERE r.id=?`, [event.provider_id, event.api_request_id]);
            // mysql2 returns BIGINT token columns as strings in the runtime pool.
            const usage = { ...event };
            for (const name of ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'cache_write_5m_tokens', 'cache_write_1h_tokens', 'output_tokens']) {
              const value = event[name] === null ? null : Number(event[name]);
              usage[name] = Number.isSafeInteger(value) && value >= 0 ? value : null;
            }
            const cost = await calculateCost(tx, {
              ...request, provider_id: event.provider_id, requestedProvider_id: event.requestedProvider_id,
              model_requested: event.requestedModel,
            }, usage, event.model);
            await tx.query(`UPDATE usage_costs SET pricing_id=?,input_cost=?,cached_input_cost=?,cache_write_cost=?,
              output_cost=?,known_cost=?,currency=?,status=?,reason=?,requested_cost=?,cache_write_5m_cost=?,cache_write_1h_cost=?,calculated_at=UTC_TIMESTAMP(3) WHERE id=?`,
            [cost.pricing_id, cost.input_cost, cost.cached_input_cost, cost.cache_write_cost, cost.output_cost,
              cost.known_cost, cost.currency, cost.status, cost.reason, cost.requested_cost, cost.cache_write_5m_cost, cost.cache_write_1h_cost, assessment.id]);
            counts.recalculated_events++;
          }
        }
        return { after: String(rows.at(-1).id), counts };
      });
      if (!batch) break;
      after = batch.after;
      for (const key of Object.keys(result)) result[key] += batch.counts[key];
    }
    if (deleting) {
      after = '0';
      while (!cancelled()) {
        const batch = await db.transaction(async tx => {
          const rows = await tx.query(`SELECT r.id FROM api_requests r WHERE r.id>? AND r.id<=?
            AND COALESCE(r.completed_at,r.started_at)<?
            AND r.request_status IN ('SUCCESS','FAILED','REJECTED','CANCELLED')
            AND NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.api_request_id=r.id)
            ORDER BY r.id LIMIT ${BATCH_SIZE} FOR UPDATE`, [after, String(requestMaximum.id), before]);
          if (!rows.length) return null;
          const ids = rows.map(row => String(row.id));
          const deleted = await tx.query(`DELETE FROM api_requests WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
          return { after: ids.at(-1), deleted: deleted.affectedRows };
        });
        if (!batch) return { ...result, completed: true };
        after = batch.after;
        result.deleted_requests += batch.deleted;
      }
    }
    return { ...result, completed: !cancelled() };
  } catch (error) {
    // Only committed batches count as progress; the failing batch is rolled back.
    error.maintenanceProgress = { ...result, completed: false };
    throw error;
  }
}
