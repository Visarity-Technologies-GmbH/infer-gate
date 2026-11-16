import { randomUUID } from 'node:crypto';
import { fail, anthropicErrorType } from '../errors.js';
import { extractUsage } from '../services/usage.js';
import { validateChat, object, imageData, readJson, safeHeaders, normalizeError, sseEvents } from './native-common.js';
import { validateMessages } from './anthropic-messages.js';

const unsupported = message => fail(400, 'unsupported_messages_translation', message);
const invalidResponse = message => fail(502, 'invalid_provider_response', message);
function fields(value, allowed, label) {
  if (!object(value)) unsupported(`Invalid ${label}`);
  const unexpected = Object.keys(value).find(key => !allowed.includes(key));
  if (unexpected !== undefined) {
    // Identify structural incompatibilities without reflecting request values.
    const name = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(unexpected) ? `: ${unexpected}` : '';
    unsupported(`Unsupported ${label} field${name}`);
  }
}
function cacheControl(value) {
  if (value === undefined) return;
  fields(value, ['type','ttl'], 'cache_control');
  if (value.type !== 'ephemeral' || (value.ttl !== undefined && !['5m','1h'].includes(value.ttl))) unsupported('Unsupported cache_control');
  // Cache placement is a provider hint; it cannot force caching on another API.
}
function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) unsupported('Only text tool results and system prompts can be translated');
  return content.map(block => {
    fields(block, ['type','text','cache_control'], 'text block'); cacheControl(block.cache_control);
    if (block.type !== 'text' || typeof block.text !== 'string') unsupported('Only text tool results and system prompts can be translated');
    return block.text;
  }).join('\n');
}

export function messagesToChat(input) {
  fields(input, ['model','max_tokens','messages','system','stream','temperature','top_p','stop_sequences','tools','tool_choice','thinking','metadata','cache_control'], 'Messages request');
  validateMessages(input);
  cacheControl(input.cache_control);
  if (input.thinking !== undefined) {
    fields(input.thinking, ['type','budget_tokens'], 'thinking');
    if (input.thinking.type !== 'disabled') unsupported('Explicit thinking controls require an Anthropic upstream; disable thinking for translated requests');
    if (input.thinking.budget_tokens !== undefined) unsupported('Thinking budgets cannot be translated');
  }
  if (input.metadata !== undefined) {
    fields(input.metadata, ['user_id'], 'metadata');
    if (input.metadata.user_id !== undefined && typeof input.metadata.user_id !== 'string') unsupported('Invalid metadata.user_id');
    // Gateway identities remain authoritative; provider-only metadata is omitted.
  }
  const result = { model: input.model, max_tokens: input.max_tokens, messages: [], stream: input.stream ?? false };
  const calls = new Map(), results = new Set();
  if (input.system !== undefined) result.messages.push({ role: 'system', content: textBlocks(input.system) });
  for (const message of input.messages) {
    fields(message, ['role','content','cache_control'], 'message'); cacheControl(message.cache_control);
    if (message.role === 'system') { result.messages.push({ role: 'system', content: textBlocks(message.content) }); continue; }
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    let content = [], toolCalls = [];
    const flush = () => {
      if (content.length || toolCalls.length) result.messages.push({ role: message.role, content: content.length ? content : null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      content = []; toolCalls = [];
    };
    for (const block of blocks) {
      if (!object(block)) unsupported('Invalid content block');
      cacheControl(block.cache_control);
      if (block.type === 'text') {
        fields(block, ['type','text','cache_control'], 'text block');
        if (typeof block.text !== 'string') unsupported('Invalid text block');
        content.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        fields(block, ['type','source','cache_control'], 'image block');
        fields(block.source, ['type','media_type','data'], 'image source');
        if (message.role !== 'user' || block.source.type !== 'base64') unsupported('Translated images require user base64 image blocks');
        const url = `data:${block.source.media_type};base64,${block.source.data}`; imageData(url);
        content.push({ type: 'image_url', image_url: { url } });
      } else if (block.type === 'tool_use') {
        fields(block, ['type','id','name','input','cache_control','extra_content'], 'tool_use block');
        if (message.role !== 'assistant' || typeof block.id !== 'string' || !block.id || calls.has(block.id) || typeof block.name !== 'string' || !block.name || !object(block.input)) unsupported('Invalid tool_use block');
        calls.set(block.id, block.name);
        toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) }, ...(block.extra_content === undefined ? {} : { extra_content: block.extra_content }) });
      } else if (block.type === 'tool_result') {
        fields(block, ['type','tool_use_id','content','is_error','cache_control'], 'tool_result block');
        if (message.role !== 'user' || !calls.has(block.tool_use_id) || results.has(block.tool_use_id) || (block.is_error !== undefined && typeof block.is_error !== 'boolean')) unsupported('tool_result requires a matching earlier tool_use');
        flush(); results.add(block.tool_use_id);
        const text = block.content === undefined ? '' : textBlocks(block.content);
        result.messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.is_error ? `[Tool error]\n${text}` : text });
      } else unsupported('This content block cannot be translated; thinking, documents and server tools require an Anthropic upstream');
    }
    flush();
  }
  for (const name of ['temperature','top_p']) if (input[name] !== undefined) result[name] = input[name];
  if (input.stop_sequences !== undefined) {
    if (!Array.isArray(input.stop_sequences) || input.stop_sequences.some(value => typeof value !== 'string')) unsupported('Invalid stop_sequences');
    result.stop = input.stop_sequences;
  }
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) unsupported('tools must be an array');
    result.tools = input.tools.map(tool => {
      fields(tool, ['type','name','description','input_schema','cache_control'], 'tool'); cacheControl(tool.cache_control);
      if (tool.type !== undefined && tool.type !== 'custom') unsupported('Server tools cannot be translated');
      if (!object(tool.input_schema) || (tool.description !== undefined && typeof tool.description !== 'string')) unsupported('Invalid custom tool schema or description');
      return { type: 'function', function: { name: tool.name, ...(tool.description === undefined ? {} : { description: tool.description }), parameters: tool.input_schema } };
    });
  }
  if (input.tool_choice !== undefined) {
    fields(input.tool_choice, ['type','name','disable_parallel_tool_use'], 'tool_choice');
    const choice = input.tool_choice;
    if (!['auto','any','none','tool'].includes(choice.type) || (choice.type === 'tool' && typeof choice.name !== 'string')) unsupported('Invalid tool_choice');
    result.tool_choice = choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type === 'any' ? 'required' : choice.type;
    if (choice.disable_parallel_tool_use !== undefined) {
      if (typeof choice.disable_parallel_tool_use !== 'boolean') unsupported('Invalid disable_parallel_tool_use');
      if (choice.disable_parallel_tool_use) result.parallel_tool_calls = false;
    }
  }
  if (result.stream) result.stream_options = { include_usage: true };
  return validateChat(result);
}

function stopReason(reason) {
  const mapped = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' }[reason];
  if (!mapped) invalidResponse('Provider returned an unsupported finish reason');
  return mapped;
}
function toolInput(value) {
  try { const input = JSON.parse(value); if (object(input)) return input; } catch { /* Fail with safe text below. */ }
  invalidResponse('Provider returned invalid tool arguments');
}
function envelope(model, id) {
  return { id: typeof id === 'string' && id ? id : `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null };
}
function nativeUsage(usage) {
  if (!usage) return { input_tokens: null, output_tokens: null };
  const read = usage.cached_input_tokens, write = usage.cache_write_input_tokens;
  const inclusive = usage.input_tokens, cached = (read ?? 0) + (write ?? 0);
  return { input_tokens: inclusive === null || inclusive < cached ? null : inclusive - cached, output_tokens: usage.output_tokens,
    ...(read === null ? {} : { cache_read_input_tokens: read }), ...(write == null ? {} : { cache_creation_input_tokens: write }) };
}
function account(state, payload, upstream, model) {
  if (payload.service_tier && !['default','standard','auto'].includes(payload.service_tier)) state.billingUnsupported = true;
  const usage = upstream.infergate?.usage || extractUsage({ ...payload, model });
  if (usage) {
    if (usage.billing_unsupported) state.billingUnsupported = true;
    state.usage = { ...usage, ...(state.billingUnsupported ? { billing_unsupported: true } : {}) };
  }
}
export async function bridgeError(upstream, type) {
  const normalized = await normalizeError(upstream, type, { nativeMessages: true }), { error } = await normalized.json();
  const response = new Response(JSON.stringify({ type: 'error', error: { type: anthropicErrorType(upstream.status), message: error.message } }), { status: upstream.status, headers: safeHeaders(upstream) });
  response.infergate = normalized.infergate; return response;
}

export async function chatToMessages(upstream, input) {
  const state = { usage: null, authoritativeUsage: true };
  if (input.stream) {
    if (!(upstream.headers.get('content-type') || '').includes('text/event-stream')) invalidResponse('Provider did not return an event stream');
    const iterator = messagesStream(upstream, input, state), encoder = new TextEncoder(), headers = safeHeaders(upstream);
    headers.set('content-type', 'text/event-stream');
    const response = new Response(new ReadableStream({
      async pull(controller) {
        try {
          const item = await iterator.next();
          if (item.done) controller.close();
          else controller.enqueue(encoder.encode(`event: ${item.value.type}\ndata: ${JSON.stringify(item.value)}\n\n`));
        } catch (error) { controller.error(error); }
      },
      async cancel() { await iterator.return?.(); },
    }, { highWaterMark: 0 }), { status: upstream.status, headers });
    response.infergate = state; return response;
  }
  const value = await readJson(upstream), choice = value.choices?.[0];
  if (!Array.isArray(value.choices) || !object(choice?.message) || !choice.finish_reason || value.choices.length !== 1) invalidResponse('Invalid chat completion');
  const message = envelope(typeof value.model === 'string' ? value.model : input.model, value.id);
  account(state, value, upstream, message.model);
  const output = choice.message;
  if (output.audio || output.function_call) invalidResponse('Provider returned unsupported output');
  if (output.content != null && typeof output.content !== 'string') invalidResponse('Provider returned unsupported message content');
  if (typeof output.content === 'string' && output.content) message.content.push({ type: 'text', text: output.content });
  if (output.refusal != null && typeof output.refusal !== 'string') invalidResponse('Invalid provider refusal');
  if (output.refusal) message.content.push({ type: 'text', text: output.refusal });
  if (output.tool_calls !== undefined && !Array.isArray(output.tool_calls)) invalidResponse('Invalid provider tool calls');
  for (const call of output.tool_calls || []) {
    if (call?.type !== 'function' || typeof call.id !== 'string' || !call.id || typeof call.function?.name !== 'string' || !call.function.name) invalidResponse('Invalid provider tool call');
    message.content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: toolInput(call.function.arguments), ...(call.extra_content === undefined ? {} : { extra_content: call.extra_content }) });
  }
  message.stop_reason = stopReason(choice.finish_reason);
  if (message.stop_reason === 'end_turn' && output.tool_calls?.length) message.stop_reason = 'tool_use';
  message.usage = nativeUsage(state.usage);
  const response = new Response(JSON.stringify(message), { status: upstream.status, headers: safeHeaders(upstream) });
  response.infergate = state; return response;
}

async function* messagesStream(upstream, input, state) {
  let message, finish, done = false, nextIndex = 0, textIndex = null, metadataBytes = 0;
  const tools = new Map();
  const stop = index => ({ type: 'content_block_stop', index });
  for await (const value of sseEvents(upstream.body, { allowDone: true })) {
    if (value === '[DONE]') { done = true; break; }
    if (!object(value)) invalidResponse('Invalid chat stream event');
    if (value.error) {
      state.error = { code: 'upstream_stream_error', type: 'server_error' };
      yield { type: 'error', error: { type: 'api_error', message: 'Upstream stream failed' } }; return;
    }
    if (!message) {
      message = envelope(typeof value.model === 'string' ? value.model : input.model, value.id);
      account(state, value, upstream, message.model);
      yield { type: 'message_start', message: { ...message, usage: nativeUsage(state.usage) } };
    } else account(state, value, upstream, typeof value.model === 'string' ? value.model : message.model);
    if (!Array.isArray(value.choices) || value.choices.length > 1) invalidResponse('Invalid chat stream choices');
    const choice = value.choices[0];
    if (!choice) continue; // The final usage-only chunk has no choices.
    if (choice.index !== undefined && choice.index !== 0) invalidResponse('Only one completion is supported');
    const delta = choice.delta;
    if (!object(delta)) invalidResponse('Invalid chat stream delta');
    if (delta.audio || delta.function_call) invalidResponse('Provider returned unsupported streamed output');
    if (finish && (delta.content || delta.tool_calls?.length)) invalidResponse('Provider sent content after finishing');
    const text = delta.content ?? delta.refusal;
    if (text != null && typeof text !== 'string') invalidResponse('Unsupported streamed content');
    if (text) {
      if (textIndex === null) {
        textIndex = nextIndex++;
        yield { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } };
      }
      yield { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } };
    }
    if (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls)) invalidResponse('Invalid streamed tool calls');
    for (const call of delta.tool_calls || []) {
      if (!Number.isSafeInteger(call?.index) || call.index < 0 || (call.type !== undefined && call.type !== 'function')) invalidResponse('Invalid streamed tool call');
      let tool = tools.get(call.index);
      if (!tool) {
        if (tools.size >= 100) invalidResponse('Too many streamed tool calls');
        tool = { id: '', name: '', arguments: '', argumentBytes: 0, opened: false, extra_content: undefined }; tools.set(call.index, tool);
      }
      if (call.id !== undefined) {
        if (typeof call.id !== 'string' || tool.opened && call.id !== tool.id) invalidResponse('Invalid streamed tool ID');
        if (!tool.opened) tool.id += call.id;
      }
      if (call.function?.name !== undefined) {
        if (typeof call.function.name !== 'string' || tool.opened) invalidResponse('Invalid streamed tool name');
        tool.name += call.function.name;
      }
      if (call.extra_content !== undefined) {
        if (tool.opened) invalidResponse('Provider sent tool metadata after its start');
        tool.extra_content = call.extra_content;
      }
      const args = call.function?.arguments ?? '';
      if (typeof args !== 'string') invalidResponse('Invalid streamed tool arguments');
      metadataBytes += Buffer.byteLength(JSON.stringify(call));
      tool.argumentBytes += Buffer.byteLength(args);
      if (metadataBytes > 10 * 1024 * 1024 || tool.argumentBytes > 1024 * 1024) invalidResponse('Streamed tool metadata exceeds the supported size');
      tool.arguments += args;
      if (!tool.opened && tool.id && tool.name && args) {
        if (textIndex !== null) { yield stop(textIndex); textIndex = null; }
        tool.opened = true; tool.index = nextIndex++;
        yield { type: 'content_block_start', index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {}, ...(tool.extra_content === undefined ? {} : { extra_content: tool.extra_content }) } };
        yield { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: tool.arguments } };
      } else if (tool.opened && args) {
        yield { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: args } };
      }
    }
    if (choice.finish_reason) finish = stopReason(choice.finish_reason);
  }
  if (!done || !message || !finish) fail(502, 'incomplete_stream', 'Provider stream ended before completion');
  if (textIndex !== null) yield stop(textIndex);
  for (const tool of tools.values()) {
    if (!tool.id || !tool.name) invalidResponse('Incomplete provider tool call');
    const args = toolInput(tool.arguments || '{}');
    if (!tool.opened) {
      tool.index = nextIndex++;
      yield { type: 'content_block_start', index: tool.index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: args, ...(tool.extra_content === undefined ? {} : { extra_content: tool.extra_content }) } };
    }
    yield stop(tool.index);
  }
  yield { type: 'message_delta', delta: { stop_reason: finish === 'end_turn' && tools.size ? 'tool_use' : finish, stop_sequence: null }, usage: nativeUsage(state.usage) };
  yield { type: 'message_stop' };
}
