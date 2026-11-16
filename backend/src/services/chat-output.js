import { UsageCollector } from './usage.js';

// Reuse the incremental SSE decoder, retaining only the assembled completion.
export class ChatOutputCollector extends UsageCollector {
  constructor(contentType, limit = 16 * 1024 * 1024) {
    super(contentType, limit);
    this.output = null; this.bytes = 0; this.truncated = false;
  }
  push(chunk) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      this.truncated = true; this.output = null; this.buffer = '';
      return;
    }
    super.push(chunk);
  }
  parse(value) {
    if (this.truncated || value.trim() === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(value); } catch { return; }
    if (!this.sse || payload.error) { this.output = payload; return; }
    if (!this.output) this.output = { object: 'chat.completion', choices: [] };
    for (const field of ['id', 'created', 'model', 'system_fingerprint', 'service_tier', 'usage']) {
      if (payload[field] !== undefined) this.output[field] = payload[field];
    }
    for (const choice of payload.choices || []) {
      const index = choice.index ?? 0;
      let target = this.output.choices.find(item => item.index === index);
      if (!target) {
        target = { index, message: { role: 'assistant', content: null }, finish_reason: null };
        this.output.choices.push(target);
      }
      if (choice.message) target.message = choice.message;
      const delta = choice.delta || {};
      for (const [field, part] of Object.entries(delta)) {
        if (field === 'tool_calls') {
          target.message.tool_calls ||= [];
          for (const tool of part) {
            const toolIndex = tool.index ?? 0;
            let call = target.message.tool_calls.find(item => item.index === toolIndex);
            if (!call) { call = { index: toolIndex }; target.message.tool_calls.push(call); }
            if (tool.id !== undefined) call.id = tool.id;
            if (tool.type !== undefined) call.type = tool.type;
            if (tool.function) {
              call.function ||= {};
              for (const [key, text] of Object.entries(tool.function)) call.function[key] = (call.function[key] || '') + text;
            }
          }
        } else if (field === 'function_call') {
          target.message.function_call ||= {};
          for (const [key, text] of Object.entries(part)) target.message.function_call[key] = (target.message.function_call[key] || '') + text;
        } else if (field === 'role') target.message.role = part;
        else if (typeof part === 'string') target.message[field] = (target.message[field] || '') + part;
        else if (part !== null) target.message[field] = part;
      }
      if (choice.finish_reason != null) target.finish_reason = choice.finish_reason;
      if (choice.logprobs) {
        target.logprobs ||= {};
        for (const [key, values] of Object.entries(choice.logprobs)) {
          if (Array.isArray(values)) target.logprobs[key] = [...(target.logprobs[key] || []), ...values];
          else target.logprobs[key] = values;
        }
      }
    }
  }
  finish() {
    if (this.truncated) return;
    super.finish();
    // Accept a final SSE event without a trailing blank line.
    if (this.sse && this.buffer.trim()) this.parse(this.buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
    if (this.sse && this.output?.choices) {
      this.output.choices.sort((a, b) => a.index - b.index);
      for (const choice of this.output.choices) if (choice.message.tool_calls) {
        choice.message.tool_calls.sort((a, b) => a.index - b.index);
        for (const call of choice.message.tool_calls) delete call.index;
      }
    }
  }
}
