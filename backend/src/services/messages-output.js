import { ChatOutputCollector } from './chat-output.js';

// Share bounded byte collection and incremental SSE decoding with chat logging,
// but assemble an Anthropic Message rather than OpenAI completion choices.
export class MessagesOutputCollector extends ChatOutputCollector {
  constructor(contentType, limit) {
    super(contentType, limit);
    this.blocks = new Map();
  }
  parse(value) {
    if (this.truncated) return;
    let payload;
    try { payload = JSON.parse(value); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    if (!this.sse) { this.output = payload; return; }
    if (payload.type === 'error' || payload.error) {
      if (this.output) this.output.error = payload.error;
      else this.output = payload;
      return;
    }
    if (payload.type === 'message_start' && payload.message) {
      this.output = { ...payload.message, content: [] };
      this.blocks.clear();
      for (const [index, block] of (payload.message.content || []).entries()) this.addBlock(index, block);
    } else if (payload.type === 'content_block_start' && this.output) {
      this.addBlock(payload.index, payload.content_block);
    } else if (payload.type === 'content_block_delta') {
      const entry = this.blocks.get(payload.index), delta = payload.delta;
      if (!entry || !delta) return;
      const field = { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature' }[delta.type];
      if (field && typeof delta[field] === 'string') entry.block[field] = (entry.block[field] || '') + delta[field];
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') entry.json = (entry.json || '') + delta.partial_json;
      if (delta.type === 'citations_delta' && delta.citation) (entry.block.citations ||= []).push(delta.citation);
    } else if (payload.type === 'content_block_stop') {
      this.finishBlock(this.blocks.get(payload.index));
    } else if (payload.type === 'message_delta' && this.output) {
      this.output = { ...this.output, ...payload.delta };
      if (payload.usage) this.output.usage = { ...this.output.usage, ...payload.usage };
    }
  }
  addBlock(index, value) {
    if (!Number.isSafeInteger(index) || index < 0 || !value || typeof value !== 'object') return;
    const block = { ...value };
    this.blocks.set(index, { block });
  }
  finishBlock(entry) {
    if (entry?.json === undefined) return;
    try { entry.block.input = JSON.parse(entry.json); delete entry.block.partial_json; }
    catch { entry.block.partial_json = entry.json; }
  }
  finish() {
    super.finish();
    if (this.truncated) { this.blocks.clear(); return; }
    for (const entry of this.blocks.values()) this.finishBlock(entry);
    if (this.output?.type === 'message' && this.blocks.size) this.output.content = [...this.blocks.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry.block);
  }
}
