import { anthropicUsage } from '../services/anthropic-usage.js';
export { anthropicUsage } from '../services/anthropic-usage.js';
import { fail } from '../errors.js';
import { extractUsage } from '../services/usage.js';
import { validateChat, textParts, imageData, parseArguments, toolResult, invalid, finishReason, chatEnvelope, readJson, safeHeaders, sseEvents, streamResponse, chunk } from './native-common.js';

export function anthropicRequest(input) {
  const body = validateChat(input), system = [], messages = [], calls = new Map();
  if (body.temperature !== undefined && body.temperature > 1) invalid('Anthropic temperature must be between 0 and 1');
  if (body.response_format !== undefined && body.response_format?.type !== 'text') invalid('Anthropic adapter currently supports text response_format only');
  const parts = content => textParts(content).map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const image = imageData(part.image_url.url);
    return { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } };
  });
  for (const message of body.messages) {
    if (['system','developer'].includes(message.role)) {
      const content = parts(message.content);
      if (content.some(part => part.type !== 'text')) invalid('System messages must contain text');
      system.push(...content); continue;
    }
    let role = message.role, content;
    if (role === 'tool') {
      toolResult(message, calls); role = 'user';
      content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }];
    } else {
      content = parts(message.content);
      for (const call of message.tool_calls || []) {
        calls.set(call.id, call.function.name);
        content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) });
      }
    }
    if (!content.length) invalid('Messages must have content or tool calls');
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  if (!messages.length) invalid('A conversation message is required');
  const result = { model: body.model, messages, max_tokens: body.max_completion_tokens ?? body.max_tokens ?? 4096, stream: body.stream || false };
  if (system.length) result.system = system;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop !== undefined) result.stop_sequences = typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (body.tools?.length) {
    result.tools = body.tools.map(({ function: fn }) => ({ name: fn.name, ...(fn.description === undefined ? {} : { description: fn.description }), input_schema: fn.parameters || { type: 'object', properties: {} } }));
    result.tool_choice = typeof body.tool_choice === 'object' ? { type: 'tool', name: body.tool_choice.function.name } : { type: body.tool_choice === 'required' ? 'any' : body.tool_choice || 'auto' };
    if (body.parallel_tool_calls !== undefined && result.tool_choice.type !== 'none') result.tool_choice.disable_parallel_tool_use = !body.parallel_tool_calls;
  }
  return result;
}
export async function anthropicResponse(upstream, input) {
  const envelope = chatEnvelope(input.model), state = { usage: null };
  if (input.stream) return streamResponse(upstream, anthropicStream(upstream, input, envelope, state), state);
  const value = await readJson(upstream);
  if (!Array.isArray(value.content) || typeof value.id !== 'string' || typeof value.model !== 'string') fail(502, 'invalid_provider_response', 'Invalid Anthropic message');
  const text = value.content.filter(part => part.type === 'text').map(part => part.text).join('');
  const tools = value.content.filter(part => part.type === 'tool_use').map(part => ({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } }));
  const result = { ...envelope, id: value.id, model: value.model, choices: [{ index: 0, message: { role: 'assistant', content: text || (tools.length ? null : ''), ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: finishReason(value.stop_reason), logprobs: null }], usage: anthropicUsage(value.usage) };
  const response = new Response(JSON.stringify(result), { status: upstream.status, headers: safeHeaders(upstream) });
  response.infergate = { usage: extractUsage(result) }; return response;
}
async function* anthropicStream(upstream, input, envelope, state) {
  let started = false, stopped = false, finish = null, usage;
  const toolIndexes = new Map();
  for await (const event of sseEvents(upstream.body)) {
    if (event.type === 'error') {
      yield { error: { message: 'Anthropic stream failed', type: 'server_error', code: 'upstream_stream_error', param: null } }; return;
    }
    if (event.type === 'message_start') {
      if (started || !event.message?.id) fail(502, 'invalid_provider_stream', 'Invalid Anthropic stream start');
      started = true; envelope.id = event.message.id; envelope.model = event.message.model || input.model;
      usage = event.message.usage;
      state.usage = extractUsage({ model: envelope.model, usage: anthropicUsage(usage) });
      yield chunk(envelope, { role: 'assistant', content: '' });
    } else if (event.type === 'content_block_start') {
      if (!started) fail(502, 'invalid_provider_stream', 'Missing Anthropic message start');
      const block = event.content_block;
      if (block?.type === 'text' && block.text) yield chunk(envelope, { content: block.text });
      if (block?.type === 'tool_use') {
        const index = toolIndexes.size; toolIndexes.set(event.index, index);
        yield chunk(envelope, { tool_calls: [{ index, id: block.id, type: 'function', function: { name: block.name, arguments: Object.keys(block.input || {}).length ? JSON.stringify(block.input) : '' } }] });
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') yield chunk(envelope, { content: event.delta.text });
      if (event.delta?.type === 'input_json_delta') {
        if (!toolIndexes.has(event.index)) fail(502, 'invalid_provider_stream', 'Unknown Anthropic tool block');
        yield chunk(envelope, { tool_calls: [{ index: toolIndexes.get(event.index), function: { arguments: event.delta.partial_json } }] });
      }
    } else if (event.type === 'message_delta') {
      if (event.usage) usage = { ...usage, ...event.usage };
      state.usage = extractUsage({ model: envelope.model, usage: anthropicUsage(usage) });
      if (event.delta?.stop_reason) finish = finishReason(event.delta.stop_reason);
    } else if (event.type === 'message_stop') {
      if (!started || !finish) fail(502, 'incomplete_stream', 'Incomplete Anthropic stream');
      stopped = true; break;
    }
  }
  if (!stopped) fail(502, 'incomplete_stream', 'Anthropic stream ended before completion');
  yield chunk(envelope, {}, finish);
  if (input.stream_options?.include_usage && usage) yield { ...envelope, object: 'chat.completion.chunk', choices: [], usage: anthropicUsage(usage) };
  yield '[DONE]';
}
