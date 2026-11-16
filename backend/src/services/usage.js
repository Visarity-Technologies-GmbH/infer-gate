import { anthropicUsage } from './anthropic-usage.js';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function extractUsage(payload) {
  const source = payload?.response || payload;
  const usage = source?.usage;
  if (!usage || typeof usage !== 'object') return null;
  return { model: typeof source.model === 'string' ? source.model.slice(0, 255) : null,
    input_tokens: count(usage.input_tokens ?? usage.prompt_tokens),
    cached_input_tokens: count(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    cache_write_input_tokens: count(usage.input_tokens_details?.cache_creation_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens),
    ...((usage.input_tokens_details ?? usage.prompt_tokens_details)?.cache_write_5m_tokens !== undefined || (usage.input_tokens_details ?? usage.prompt_tokens_details)?.cache_write_1h_tokens !== undefined ? {
      cache_write_5m_tokens: count((usage.input_tokens_details ?? usage.prompt_tokens_details)?.cache_write_5m_tokens),
      cache_write_1h_tokens: count((usage.input_tokens_details ?? usage.prompt_tokens_details)?.cache_write_1h_tokens),
    } : {}),
    output_tokens: count(usage.output_tokens ?? usage.completion_tokens),
    reasoning_tokens: count(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens),
    total_tokens: count(usage.total_tokens),
    ...(usage.billing_unsupported || (source.service_tier && !['default','standard','auto'].includes(source.service_tier)) || (usage.input_tokens_details?.audio_tokens > 0) || (usage.prompt_tokens_details?.audio_tokens > 0) || (usage.output_tokens_details?.audio_tokens > 0) || (usage.completion_tokens_details?.audio_tokens > 0) ? { billing_unsupported: true } : {}) };
}
// Inspection is bounded independently of forwarding. Large events are skipped, never truncated into invented usage.
export class UsageCollector {
  constructor(contentType, limit = 1024 * 1024, protocol = 'OPENAI') {
    this.protocol = protocol; this.anthropicStarted = false; this.anthropicFinished = false; this.anthropicCounters = null;
    this.sse = contentType.includes('text/event-stream'); this.json = contentType.includes('json');
    this.limit = limit; this.decoder = new TextDecoder(); this.buffer = ''; this.skipping = false;
    this.billingUnsupported = false; this.usage = null; this.model = null; this.terminal = false; this.failed = false;
  }
  parse(value) {
    if (this.protocol !== 'ANTHROPIC' && value.trim() === '[DONE]') { this.terminal = true; return; }
    try {
      const payload = JSON.parse(value);
      if (this.protocol === 'ANTHROPIC') { this.parseAnthropic(payload); return; }
      const source = payload.response || payload;
      if (typeof source.model === 'string') this.model = source.model.slice(0, 255);
      if (source.service_tier && !['default','standard','auto'].includes(source.service_tier)) this.billingUnsupported = true;
      const usage = extractUsage(payload); if (usage) this.usage = usage;
      if (this.usage && this.billingUnsupported) this.usage.billing_unsupported = true;
      if (['response.completed', 'response.failed', 'response.incomplete'].includes(payload.type)) this.terminal = true;
      if (payload.error || ['response.failed', 'response.incomplete', 'error'].includes(payload.type)) this.failed = true;
    } catch { /* Binary, unrelated or invalid events do not supply accounting data. */ }
  }
  parseAnthropic(payload) {
    const source = payload.type === 'message_start' ? payload.message : payload;
    if (typeof source?.model === 'string') this.model = source.model.slice(0, 255);
    if (payload.type === 'message_start') this.anthropicStarted = true;
    if (source?.service_tier && !['default','standard','auto'].includes(source.service_tier)) this.billingUnsupported = true;
    if (source?.usage && typeof source.usage === 'object') {
      this.anthropicCounters = { ...this.anthropicCounters, ...source.usage };
      this.usage = extractUsage({ model: this.model, usage: anthropicUsage(this.anthropicCounters) });
      if (this.usage?.billing_unsupported) this.billingUnsupported = true;
      if (this.usage && this.billingUnsupported) this.usage.billing_unsupported = true;
    }
    if (payload.type === 'message_delta' && payload.delta?.stop_reason) this.anthropicFinished = true;
    if (payload.type === 'message_stop' && this.anthropicStarted && this.anthropicFinished) this.terminal = true;
    if (payload.type === 'error' || payload.error) this.failed = true;
  }
  push(chunk) {
    if (!this.sse && !this.json) return;
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) { if (!this.skipping) { this.buffer += text; if (this.buffer.length > this.limit) { this.buffer = ''; this.skipping = true; } } return; }
    // Process lines so an oversized event cannot grow memory without bound.
    for (const piece of text.split(/(?<=\n)/)) {
      this.buffer += piece;
      if (this.buffer.length > this.limit) { this.buffer = ''; this.skipping = true; }
      if (piece.endsWith('\n') && /(?:^|\n)\r?\n$/.test(this.buffer)) {
        if (!this.skipping) this.parse(this.buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
        this.buffer = ''; this.skipping = false;
      } else if (this.skipping && piece === '\n') { this.buffer = ''; this.skipping = false; }
    }
  }
  finish() { this.buffer += this.decoder.decode(); if (this.json && !this.skipping) this.parse(this.buffer); }
}
