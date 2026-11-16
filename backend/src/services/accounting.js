export function supportsTokenBilling(body, { anthropic = false } = {}) {
  if (body.service_tier && !['default','standard','auto'].includes(body.service_tier)) return false;
  if (Array.isArray(body.tools) && body.tools.some(tool => anthropic ? tool?.type !== undefined && tool?.type !== 'custom' : tool?.type !== 'function')) return false;
  if (Array.isArray(body.modalities) && body.modalities.some(value => value !== 'text')) return false;
  const items = [...(Array.isArray(body.messages) ? body.messages : []), ...(Array.isArray(body.input) ? body.input : [])];
  return !items.some(item => ['input_image','input_audio','input_file'].includes(item?.type) ||
    (Array.isArray(item?.content) && item.content.some(part => !(anthropic ? ['text','thinking','redacted_thinking','tool_use','tool_result'] : ['text','input_text','output_text']).includes(part?.type) || (anthropic && part?.type === 'tool_result' && Array.isArray(part.content) && part.content.some(block => block?.type !== 'text')))));
}
// Rates are decimal strings. BigInt arithmetic rounds each cost component half up to 12 places.
export function normalizeRate(value) {
  if (value === null) return null;
  if (!['string', 'number'].includes(typeof value) || String(value).length > 256) throw new Error('Invalid price');
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new Error('Invalid price');
  const exponent = Number(match[3] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error('Invalid price');
  const fraction = match[2] || '', shift = 8 + exponent - fraction.length;
  let n = BigInt(match[1] + fraction);
  if (shift >= 0) n *= 10n ** BigInt(shift);
  else { const divisor = 10n ** BigInt(-shift); n = (n + divisor / 2n) / divisor; }
  if (n >= 10n ** 20n) throw new Error('Price exceeds supported precision');
  return format(n, 8);
}
function format(value, scale = 12) {
  const s = value.toString().padStart(scale + 1, '0');
  return `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}
function units(rate) { return rate === null || rate === undefined ? null : BigInt(normalizeRate(rate).replace('.', '')); }
function tokens(n) { return Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : null; }
function component(n, rate) {
  if (n === 0n) return 0n;
  const r = units(rate);
  return n === null || r === null ? null : (n * r + 50n) / 100n;
}
export function estimateCost(usage, pricing, { anthropic = false, supported = true } = {}) {
  const empty = { status: !supported ? 'UNSUPPORTED' : 'UNPRICED', reason: !supported ? 'Billing mode or endpoint is unsupported' : 'No applicable model price', input_cost: null, cached_input_cost: null, cache_write_cost: null, cache_write_5m_cost: null, cache_write_1h_cost: null, output_cost: null, known_cost: null };
  if (usage.billing_unsupported) return { ...empty, status: 'UNSUPPORTED', reason: 'Provider reported an unsupported billing mode' };
  if (!supported || !pricing) return empty;
  if (pricing.source_kind === 'FEED' && /:(batch|fast|priority|flex)$/.test(pricing.source_model_id || '')) return { ...empty, status: 'UNSUPPORTED', reason: 'Special pricing variant requires supported billing rules' };
  if (pricing.subscription) return { ...empty, status: 'UNSUPPORTED', reason: 'Subscription billing requires a manual price override' };
  // Assume unreported cache reads/writes are zero for this estimate; retain NULL in the usage event.
  const input = tokens(usage.input_tokens), read = tokens(usage.cached_input_tokens ?? 0);
  const write = anthropic ? tokens(usage.cache_write_input_tokens ?? 0) : 0n;
  if ((input !== null && read !== null && read > input) || (input !== null && write !== null && write > input) || (input !== null && read !== null && write !== null && read + write > input)) {
    return { ...empty, status: 'PARTIAL', reason: 'Invalid cache token breakdown' };
  }
  const splitWrites = anthropic && (usage.cache_write_5m_tokens != null || usage.cache_write_1h_tokens != null);
  const write5m = splitWrites ? tokens(usage.cache_write_5m_tokens) : 0n;
  const write1h = splitWrites ? tokens(usage.cache_write_1h_tokens) : 0n;
  if (splitWrites && write !== null && write5m !== null && write1h !== null && write5m + write1h !== write) {
    return { ...empty, status: 'PARTIAL', reason: 'Invalid cache token breakdown' };
  }
  let inputCost = null, readCost = null, writeCost = null;
  let write5mCost = splitWrites ? null : 0n, write1hCost = splitWrites ? null : 0n;
  if (input !== null && read !== null && write !== null) {
    inputCost = component(input - read - write, pricing.input_price_per_million);
    readCost = component(read, pricing.cached_input_price_per_million);
    if (splitWrites) {
      // Existing generic Anthropic write rates describe 5-minute writes only.
      write5mCost = component(write5m, pricing.cache_write_5m_rate ?? pricing.cache_write_price_per_million);
      write1hCost = component(write1h, pricing.cache_write_1h_rate);
      if (write5mCost !== null && write1hCost !== null) writeCost = write5mCost + write1hCost;
    } else writeCost = component(write, pricing.cache_write_price_per_million);
  }
  // Output includes reasoning for the normalized supported APIs; never add reasoning twice.
  const outputCost = component(tokens(usage.output_tokens), pricing.output_price_per_million);
  const parts = [inputCost, readCost, writeCost, outputCost], complete = parts.every(x => x !== null);
  const known = [inputCost, readCost, ...(splitWrites ? [write5mCost, write1hCost] : [writeCost]), outputCost].filter(x => x !== null);
  return { status: complete ? 'COMPLETE' : 'PARTIAL', reason: complete ? null : 'Missing token breakdown or price',
    input_cost: inputCost === null ? null : format(inputCost), cached_input_cost: readCost === null ? null : format(readCost),
    cache_write_cost: writeCost === null ? null : format(writeCost), output_cost: outputCost === null ? null : format(outputCost),
    cache_write_5m_cost: splitWrites && write5mCost !== null ? format(write5mCost) : null,
    cache_write_1h_cost: splitWrites && write1hCost !== null ? format(write1hCost) : null,
    known_cost: known.length ? format(known.reduce((a, b) => a + b, 0n)) : null };
}
async function findPricing(tx, providerId, model) {
  if (providerId == null || !model) return null;
  const [pricing] = await tx.query(`SELECT * FROM model_pricing WHERE provider_id=? AND model_pattern=? ORDER BY (source_kind='MANUAL') DESC,id DESC LIMIT 1`, [providerId, model]);
  return pricing ?? null;
}
export async function calculateCost(tx, record, usage, model) {
  const pricing = await findPricing(tx, record.provider_id, model);
  const endpoint = record.endpoint.replace(/\/$/, '');
  const supported = record.cost_supported !== false && ['/v1/messages', '/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/embeddings'].includes(endpoint);
  // Dual providers use native Anthropic counters only on Messages. Bedrock does
  // so only for Claude Messages; other Mantle models use OpenAI accounting.
  const anthropic = record.api_type === 'ANTHROPIC' || (record.api_type === 'OPENAI_ANTHROPIC' && endpoint === '/v1/messages') || (record.api_type === 'AWS_BEDROCK' &&
    endpoint === '/v1/messages' && (record.model_resolved || model || '').startsWith('anthropic.'));
  const cost = estimateCost(usage, pricing, { anthropic, supported });
  let requestedCost = null;
  if (cost.status === 'COMPLETE' && (model !== record.model_requested ||
      String(record.provider_id) !== String(record.requestedProvider_id))) {
    const requestedPricing = await findPricing(tx, record.requestedProvider_id, record.model_requested);
    // This comparison uses the same reported workload at the requested model's rates.
    // Normalize missing counts only here; never change the recorded usage event.
    if (requestedPricing && requestedPricing.currency === pricing.currency) {
      const requested = estimateCost({ ...usage,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cached_input_tokens: usage.cached_input_tokens ?? 0,
        cache_write_input_tokens: usage.cache_write_input_tokens ?? 0,
      }, requestedPricing, { anthropic: true });
      if (requested.status === 'COMPLETE') requestedCost = requested.known_cost;
    }
  }
  return { pricing_id: pricing?.id ?? null, ...cost, currency: pricing?.currency || 'USD', requested_cost: requestedCost };
}
export async function recordCost(tx, eventId, record, usage, model) {
  const cost = await calculateCost(tx, record, usage, model);
  await tx.query(`INSERT INTO usage_costs(usage_event_id,pricing_id,input_cost,cached_input_cost,cache_write_cost,output_cost,known_cost,currency,status,reason,requested_cost,cache_write_5m_cost,cache_write_1h_cost,calculated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,
    [eventId, cost.pricing_id, cost.input_cost, cost.cached_input_cost, cost.cache_write_cost, cost.output_cost, cost.known_cost, cost.currency, cost.status, cost.reason, cost.requested_cost, cost.cache_write_5m_cost, cost.cache_write_1h_cost]);
}
