import { recordCost } from './accounting.js';
export async function startRequest(db, record) {
  const result = await db.query(`INSERT INTO api_requests(request_id,endpoint,http_method,started_at,request_status) VALUES (?,?,?,?,'RECEIVED')`, [record.request_id, record.endpoint, record.http_method, record.started_at]);
  record.id = result.insertId;
}
export async function finalizeRequest(db, record, usage) {
  await db.transaction(async tx => {
    // Upstream 4xx responses (authentication, validation, rate limiting) without usage
    // are not evidence of consumed tokens. Successful/ambiguous calls require usage.
    const usageExpected = !!record.usage_expected && !(record.http_status >= 400 && record.http_status < 500);
    await tx.query('UPDATE api_requests SET usage_expected=? WHERE id=?', [usageExpected, record.id]);
    await tx.query(`UPDATE api_requests SET user_id=?,proxy_api_key_id=?,upstream_api_key_id=?,provider_id=?,model_requested=?,model_resolved=?,stream=?,completed_at=?,duration_ms=?,http_status=?,request_status=?,upstream_request_id=?,error_type=?,error_code=?,aws_region=?,role_id=? WHERE id=?`,
      [record.user_id ?? null, record.proxy_api_key_id ?? null, record.upstream_api_key_id ?? null, record.provider_id ?? null, record.model_requested ?? null, record.model_resolved ?? null, record.stream || false, new Date(), Date.now() - record.started_at.getTime(), record.http_status ?? null, record.request_status, record.upstream_request_id ?? null, record.error_type ?? null, record.error_code ?? null, record.aws_region ?? null, record.role_id ?? null, record.id]);
    if (usage) {
      const model = record.model_resolved || record.model_requested || null;
      const event = await tx.query(`INSERT INTO usage_events(api_request_id,user_id,proxy_api_key_id,upstream_api_key_id,provider_id,model,input_tokens,cached_input_tokens,cache_write_input_tokens,output_tokens,reasoning_tokens,total_tokens,request_status,timestamp,category,sensitive_data,requestedModel,complexity,requestedProvider_id,cache_write_5m_tokens,cache_write_1h_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [record.id, record.user_id, record.proxy_api_key_id, record.upstream_api_key_id, record.provider_id, model, usage.input_tokens, usage.cached_input_tokens, usage.cache_write_input_tokens ?? null, usage.output_tokens, usage.reasoning_tokens, usage.total_tokens, record.request_status, new Date(), record.evaluation?.category ?? null, record.evaluation?.sensitiveData ?? null, record.model_requested ?? null, record.evaluation?.complexity ?? null, record.requestedProvider_id ?? null, usage.cache_write_5m_tokens ?? null, usage.cache_write_1h_tokens ?? null]);
      await recordCost(tx, event.insertId, record, usage, model);
    }
  });
}
