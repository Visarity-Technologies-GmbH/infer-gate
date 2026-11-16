import { randomUUID } from 'node:crypto';
import { fail } from '../errors.js';

export const number = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function invalid(message) { fail(400, 'unsupported_native_request', message); }
export function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export function parseArguments(value) {
  try { const parsed = JSON.parse(value); if (object(parsed)) return parsed; } catch { /* reported below */ }
  invalid('Tool arguments must be a JSON object');
}
export function validateChat(body) {
  const supported = new Set(['model','messages','max_tokens','max_completion_tokens','temperature','top_p','stop','stream','stream_options','tools','tool_choice','parallel_tool_calls','response_format','n']);
  if (!object(body)) invalid('Expected a JSON object');
  for (const field of Object.keys(body)) if (!supported.has(field)) invalid(`The native adapter does not support ${field}`);
  if (typeof body.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(body.model)) invalid('Use the model ID returned by /v1/models');
  if (!Array.isArray(body.messages) || !body.messages.length) invalid('messages must be a non-empty array');
  if (body.n !== undefined && body.n !== 1) invalid('Native adapters support n=1');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') invalid('stream must be a boolean');
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) invalid('Supply only one token limit');
  for (const key of ['max_tokens','max_completion_tokens']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) invalid(`${key} must be a positive integer`);
  for (const key of ['temperature','top_p']) if (body[key] !== undefined && (typeof body[key] !== 'number' || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > (key === 'top_p' ? 1 : 2))) invalid(`Invalid ${key}`);
  if (body.stop !== undefined && !(typeof body.stop === 'string' || Array.isArray(body.stop) && body.stop.every(s => typeof s === 'string'))) invalid('Invalid stop sequences');
  if (body.stream_options !== undefined && (!object(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage') || typeof body.stream_options.include_usage !== 'boolean')) invalid('Only stream_options.include_usage is supported');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some(tool => tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name || tool.function.strict === true || (tool.function.parameters !== undefined && !object(tool.function.parameters))))) invalid('Only function tools without strict mode are supported');
  if (body.response_format !== undefined && (!object(body.response_format) || typeof body.response_format.type !== 'string')) invalid('Invalid response_format');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') invalid('parallel_tool_calls must be a boolean');
  if (body.tool_choice !== undefined && !['auto','none','required'].includes(body.tool_choice) && !(body.tool_choice?.type === 'function' && typeof body.tool_choice.function?.name === 'string')) invalid('Unsupported tool_choice');
  if (body.tool_choice && body.tool_choice !== 'none' && !body.tools?.length) invalid('tool_choice requires tools');
  if (object(body.tool_choice) && !body.tools.some(t => t.function.name === body.tool_choice.function.name)) invalid('tool_choice must name a declared tool');
  for (const message of body.messages) {
    if (!object(message) || !['system','developer','user','assistant','tool'].includes(message.role)) invalid('Unsupported message role');
    for (const field of Object.keys(message)) if (!['role','content','tool_calls','tool_call_id'].includes(field)) invalid(`Unsupported message field: ${field}`);
    if (message.tool_calls !== undefined && (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.some(t => t?.type !== 'function' || typeof t.id !== 'string' || typeof t.function?.name !== 'string' || typeof t.function?.arguments !== 'string'))) invalid('Invalid assistant tool calls');
  }
  return body;
}
export function textParts(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) invalid('Unsupported message content');
  return content.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return part;
    if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') return part;
    invalid('Only text and image_url content is supported');
  });
}
export function imageData(url) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
  if (!match) invalid('Native adapters require base64 data URLs for images');
  return { mimeType: match[1], data: match[2] };
}
export function toolResult(message, calls) {
  if (typeof message.tool_call_id !== 'string' || !calls.has(message.tool_call_id) || typeof message.content !== 'string') invalid('Tool results require a matching earlier tool call and string content');
  return calls.get(message.tool_call_id);
}
export function finishReason(reason) {
  if (['tool_use'].includes(reason)) return 'tool_calls';
  if (['max_tokens','MAX_TOKENS'].includes(reason)) return 'length';
  if (['refusal','SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII','IMAGE_SAFETY'].includes(reason)) return 'content_filter';
  return 'stop';
}
export function chatEnvelope(model) {
  return { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model };
}
export function nativeHeaders(type, key) {
  const headers = new Headers({ 'content-type': 'application/json', 'accept-encoding': 'identity' });
  if (type === 'ANTHROPIC') { headers.set('x-api-key', key); headers.set('anthropic-version', '2023-06-01'); }
  else headers.set('x-goog-api-key', key);
  return headers;
}
export async function readJson(response, limit = 10 * 1024 * 1024) {
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) fail(502, 'invalid_provider_response', 'Provider response exceeds the supported size');
    chunks.push(chunk);
  }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (object(value)) return value; } catch { /* reported below */ }
  fail(502, 'invalid_provider_response', 'Provider returned invalid JSON');
}
export function safeError(status) {
  const type = status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error';
  return { error: { message: `Upstream provider request failed (HTTP ${status})`, type, code: `upstream_${status}`, param: null } };
}
export function safeHeaders(response) {
  const headers = new Headers({ 'content-type': 'application/json' });
  const requestId = response.headers.get('request-id') || response.headers.get('x-request-id');
  if (requestId) headers.set('x-request-id', requestId);
  if (response.headers.get('retry-after')) headers.set('retry-after', response.headers.get('retry-after'));
  return headers;
}
export async function normalizeError(response, providerType, { nativeMessages = false } = {}) {
  let native;
  try { native = (await readJson(response, 64 * 1024)).error; }
  catch { /* Malformed or oversized errors retain their HTTP status and safe fallback. */ }
  const payload = safeError(response.status);
  // Use only recognized categories and fixed messages. Never reflect provider text,
  // which can include request contents, credentials or internal diagnostics.
  if (providerType === 'GEMINI' && response.status === 503 && native?.status === 'UNAVAILABLE') {
    payload.error.code = 'upstream_unavailable';
    payload.error.message = /high demand|overloaded/i.test(typeof native.message === 'string' ? native.message : '')
      ? 'The Gemini model is experiencing high demand. Retry later.'
      : 'Gemini is temporarily unavailable. Retry later.';
  } else if (providerType === 'ANTHROPIC' && response.status === 529 && native?.type === 'overloaded_error') {
    payload.error.code = 'upstream_overloaded';
    payload.error.message = 'Anthropic is temporarily overloaded. Retry later.';
  }
  if (nativeMessages && providerType === 'ANTHROPIC' && response.status === 400 && typeof native?.message === 'string') {
    // Claude Code matches these phrases to compact context or retry a capability.
    // Return fixed vocabulary only, never the provider's diagnostic text.
    const recoveries = [
      [/prompt is too long/i, 'prompt is too long'],
      [/thinking\.type[. :'"]*enabled.{0,40}(?:not supported|unsupported)/i, 'thinking.type.enabled is not supported'],
      [/thinking\.type[. :'"]*adaptive.{0,40}(?:not supported|unsupported)/i, 'thinking.type.adaptive is not supported'],
      [/bound to a different conversation/i, 'thinking block is bound to a different conversation'],
      [/context_management.{0,40}Extra inputs are not permitted/i, 'context_management: Extra inputs are not permitted'],
      [/output_config\.effort.{0,40}Extra inputs are not permitted/i, 'output_config.effort: Extra inputs are not permitted'],
    ];
    const recovery = recoveries.find(([pattern]) => pattern.test(native.message));
    if (recovery) payload.error.message = recovery[1];
  }
  if (nativeMessages && response.status === 400 && typeof native?.message === 'string' &&
      /system message must be at the beginning|unexpected role ["']system["']/i.test(native.message)) {
    // Claude Code retries these requests without mid-conversation system roles.
    // Keep its recognized cue, without reflecting backend prompts/diagnostics.
    payload.error.message = 'capability_rejected: mid_conv_system';
  }
  const normalized = new Response(JSON.stringify(payload), { status: response.status, headers: safeHeaders(response) });
  normalized.infergate = { error: { code: payload.error.code, type: payload.error.type } };
  return normalized;
}


// SSE events are bounded; decoding handles CRLF and arbitrary UTF-8 boundaries.
export async function* sseEvents(body, { allowDone = false, allowUnterminatedDone = false } = {}) {
  if (!body) fail(502, 'incomplete_stream', 'Provider returned no stream');
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
      if (event.length > 1024 * 1024) fail(502, 'invalid_provider_stream', 'Provider stream event is too large');
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      if (allowDone && data.trim() === '[DONE]') { yield '[DONE]'; continue; }
      let value;
      try { value = JSON.parse(data); } catch { fail(502, 'invalid_provider_stream', 'Provider returned an invalid stream event'); }
      yield value;
    }
    if (buffer.length > 1024 * 1024) fail(502, 'invalid_provider_stream', 'Provider stream event is too large');
  }
  buffer += decoder.decode();
  if (allowDone && allowUnterminatedDone && /^data: ?\[DONE\]\s*$/.test(buffer)) { yield '[DONE]'; return; }
  if (buffer.trim()) fail(502, 'incomplete_stream', 'Provider stream ended during an event');
}
export function streamResponse(upstream, iterator, state) {
  const encoder = new TextEncoder(), headers = safeHeaders(upstream);
  headers.set('content-type', 'text/event-stream');
  const response = new Response(new ReadableStream({
    async pull(controller) {
      try { const item = await iterator.next(); if (item.done) controller.close(); else controller.enqueue(encoder.encode(`data: ${typeof item.value === 'string' ? item.value : JSON.stringify(item.value)}\n\n`)); }
      catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); }
  }, { highWaterMark: 0 }), { status: upstream.status, headers });
  response.infergate = state;
  return response;
}
export function chunk(envelope, delta = {}, finish_reason = null) {
  return { ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason, logprobs: null }] };
}
