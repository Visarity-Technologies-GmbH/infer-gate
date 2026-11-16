const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Anthropic input_tokens excludes cache reads/writes; gateway input is inclusive.
export function anthropicUsage(usage) {
  if (!usage) return undefined;
  let input = count(usage.input_tokens);
  for (const name of ['cache_read_input_tokens','cache_creation_input_tokens']) {
    if (usage[name] !== undefined) { const n = count(usage[name]); input = input === null || n === null || !Number.isSafeInteger(input + n) ? null : input + n; }
  }
  const output = count(usage.output_tokens);
  // Derive only from known normalized components. Input already includes cache
  // reads/writes, and output already includes thinking; neither is added again.
  const derivedTotal = input !== null && output !== null && Number.isSafeInteger(input + output) ? input + output : null;
  const total = usage.total_tokens == null ? derivedTotal : count(usage.total_tokens);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total,
    billing_unsupported: usage.server_tool_use?.web_search_requests > 0 || usage.server_tool_use?.web_fetch_requests > 0 || (usage.service_tier && !['standard','default','auto'].includes(usage.service_tier)),
    // Thinking is already included in output_tokens; retain this breakdown only
    // for reporting, never add it to output or bill it a second time.
    prompt_tokens_details: { cached_tokens: count(usage.cache_read_input_tokens), cache_creation_tokens: count(usage.cache_creation_input_tokens),
      cache_write_5m_tokens: count(usage.cache_creation?.ephemeral_5m_input_tokens),
      cache_write_1h_tokens: count(usage.cache_creation?.ephemeral_1h_input_tokens) },
    completion_tokens_details: { reasoning_tokens: count(usage.output_tokens_details?.thinking_tokens ?? usage.output_tokens_details?.reasoning_tokens) } };
}
