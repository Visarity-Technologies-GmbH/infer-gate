import { fail, anthropicErrorType } from '../errors.js';
import { upstreamUrl, compressBody, providerCompression } from './openai-compatible.js';
import { nativeHeaders, normalizeError, sseEvents } from './native-common.js';
import { bedrockMessagesBaseUrl } from './bedrock.js';

export const messagesPath = url => /^\/messages(?:\/count_tokens)?\/?$/.test(url.split('?')[0]);
export const tokenCountPath = url => /^\/messages\/count_tokens\/?$/.test(url.split('?')[0]);

export function validateMessages(input, counting = false) {
  if (typeof input.model !== 'string' || !input.model || input.model.length > 255) fail(400, 'invalid_model', 'A model is required');
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.some(message => !message || !['system','user','assistant'].includes(message.role) || !(typeof message.content === 'string' || Array.isArray(message.content)))) fail(400, 'invalid_messages', 'messages must contain system, user or assistant messages with content');
  if (input.system !== undefined && !(typeof input.system === 'string' || Array.isArray(input.system))) fail(400, 'invalid_system', 'system must be a string or content array');
  if (!counting && (!Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1)) fail(400, 'invalid_max_tokens', 'max_tokens must be a positive integer');
}

// Keep native blocks, tools, thinking, cache controls and future fields intact.
export function prepareMessagesRequest(assignment, req, body, credential, signal) {
  if (!['ANTHROPIC','OPENAI_ANTHROPIC','AWS_BEDROCK'].includes(assignment.api_type)) fail(400, 'unsupported_provider_endpoint', 'Native Anthropic Messages requests require an Anthropic or Bedrock provider');
  if (req.method !== 'POST') fail(405, 'method_not_allowed', 'Anthropic Messages endpoints require POST');
  const headers = nativeHeaders('ANTHROPIC', credential);
  const compression = providerCompression(assignment, 'messages');
  if (compression !== 'NONE') headers.set('content-encoding', compression.toLowerCase());
  const blocked = new Set((req.get('connection') || '').toLowerCase().split(',').map(name => name.trim()));
  for (const name of Object.keys(req.headers || {})) {
    if ((name.startsWith('anthropic-') || ['accept','content-type'].includes(name)) && !blocked.has(name) && req.get(name)) headers.set(name, req.get(name));
  }
  let base = assignment.api_url;
  if (assignment.api_type === 'AWS_BEDROCK') base = bedrockMessagesBaseUrl(assignment.aws_region);
  if (assignment.api_type === 'OPENAI_ANTHROPIC') base = assignment.anthropic_api_url || base;
  return { type: assignment.api_type, nativeMessages: true, url: upstreamUrl(base, req.url), init: { method: 'POST', headers, body: compressBody(body, compression), signal, redirect: 'manual' } };
}

export async function messagesResponse(upstream) {
  if (!upstream.ok) {
    const normalized = await normalizeError(upstream, 'ANTHROPIC', { nativeMessages: true });
    const { error } = await normalized.json();
    const headers = new Headers(upstream.headers); headers.set('content-type', 'application/json');
    const response = new Response(JSON.stringify({ type: 'error', error: { type: anthropicErrorType(upstream.status), message: error.message } }), { status: upstream.status, headers });
    response.infergate = normalized.infergate;
    return response;
  }
  if (!(upstream.headers.get('content-type') || '').includes('text/event-stream')) return upstream;
  // Relay every native event, including pings, thinking and unknown future events.
  // Bound each event and replace diagnostic error text just as the chat adapter does.
  const iterator = sseEvents(upstream.body), encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (item.done) { controller.close(); return; }
        const errorType = ['overloaded_error','rate_limit_error','api_error'].includes(item.value?.error?.type) ? item.value.error.type : 'api_error';
        const event = item.value?.type === 'error' ? { type: 'error', error: { type: errorType, message: 'Upstream stream failed' } } : item.value;
        const name = typeof event?.type === 'string' && /^[a-z_]+$/.test(event.type) ? `event: ${event.type}\n` : '';
        controller.enqueue(encoder.encode(`${name}data: ${JSON.stringify(event)}\n\n`));
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return?.(); },
  }, { highWaterMark: 0 }), { status: upstream.status, headers: upstream.headers });
}

