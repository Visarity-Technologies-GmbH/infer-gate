import { messagesPath, prepareMessagesRequest, messagesResponse } from './anthropic-messages.js';
import { messagesToChat, chatToMessages, bridgeError } from './messages-bridge.js';
import { bedrockBaseUrl, bedrockAnthropicModel, bedrockChatResponse } from './bedrock.js';
import { fail } from '../errors.js';
import { resolveUpstreamCredential } from '../security/upstream-credential.js';
import { upstreamUrl, requestHeaders, accountingBody, compressBody, providerCompression } from './openai-compatible.js';
import { nativeHeaders, normalizeError, readJson, safeHeaders, invalid } from './native-common.js';
import { anthropicRequest, anthropicResponse } from './anthropic.js';
import { geminiRequest, geminiResponse } from './gemini.js';

export function providerType(assignment) { return assignment.api_type || 'OPENAI_COMPATIBLE'; }
export function prepareProviderRequest(assignment, req, body, config, signal) {
  const type = providerType(assignment), credential = resolveUpstreamCredential(assignment.encrypted_api_key, config.encryptionKey);
  if (messagesPath(req.url)) {
    if (['ANTHROPIC', 'OPENAI_ANTHROPIC'].includes(type) || (type === 'AWS_BEDROCK' && bedrockAnthropicModel(JSON.parse(body.toString('utf8')).model))) return prepareMessagesRequest(assignment, req, body, credential, signal);
    if (/^\/messages\/count_tokens\/?$/.test(req.url.split('?')[0])) fail(501, 'token_counting_unsupported', 'Token counting requires an Anthropic upstream or a Bedrock Anthropic model');
    if (req.method !== 'POST') fail(405, 'method_not_allowed', 'Anthropic Messages endpoints require POST');
    const params = new URL(req.url, 'http://localhost').searchParams;
    if ([...params].some(([key, value]) => key !== 'beta' || value !== 'true')) fail(400, 'unsupported_messages_translation', 'Unsupported query parameter for translated Messages');
    const input = messagesToChat(JSON.parse(body.toString('utf8')));
    const chatRequest = { method: 'POST', url: '/chat/completions', get: name => name === 'content-type' ? 'application/json' : name === 'accept' ? input.stream ? 'text/event-stream' : 'application/json' : undefined };
    return { ...prepareProviderRequest(assignment, chatRequest, Buffer.from(JSON.stringify(input)), config, signal), messagesBridge: true, bridgeInput: input };
  }
  if (['OPENAI_COMPATIBLE', 'OPENAI_ANTHROPIC', 'AWS_BEDROCK'].includes(type)) {
    const path = req.url.split('?')[0];
    // Resolve the trusted upstream URL first so configuration errors (e.g. an invalid Bedrock region) win over body parsing.
    const url = upstreamUrl(type === 'AWS_BEDROCK' ? bedrockBaseUrl(assignment.aws_region) : assignment.api_url, req.url);
    const endpoint = /^\/responses\/?$/.test(path) ? 'responses' : /^\/messages(?:\/|$)/.test(path) ? 'messages' : 'chat';
    const compression = providerCompression(assignment, endpoint);
    const headers = requestHeaders(req, credential), rawPayload = ['GET','HEAD'].includes(req.method) ? undefined : accountingBody(req, body);
    const payload = compressBody(rawPayload, compression);
    if (payload !== undefined && compression !== 'NONE') headers.set('content-encoding', compression.toLowerCase());
    return { url, init: { method: req.method, headers, body: payload, signal, redirect: 'manual' }, type };
  }
  if (!['ANTHROPIC','GEMINI'].includes(type)) fail(503, 'invalid_provider_type', 'Unknown provider API type');
  const path = req.url.split('?')[0];
  const headers = nativeHeaders(type, credential);
  if (req.method === 'GET' && /^\/models\/?$/.test(path)) return { type, models: true, url: upstreamUrl(assignment.api_url, '/models'), init: { method: 'GET', headers, signal, redirect: 'manual' } };
  if (req.method !== 'POST' || !/^\/chat\/completions\/?$/.test(path)) fail(400, 'unsupported_provider_endpoint', 'Native providers support /models and /chat/completions; this endpoint is not mapped');
  if (req.url.includes('?')) invalid('Native chat adapters do not accept query parameters');
  if (!(req.get('content-type') || '').includes('application/json')) invalid('Native chat adapters require application/json');
  let input;
  try { input = JSON.parse(body.toString('utf8')); } catch { invalid('Malformed JSON body'); }
  const mapped = type === 'ANTHROPIC' ? anthropicRequest(input) : geminiRequest(input);
  const suffix = type === 'ANTHROPIC' ? '/messages' : `/models/${encodeURIComponent(input.model)}:${input.stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  const rawPayload = JSON.stringify(mapped), compression = providerCompression(assignment, 'chat');
  if (compression !== 'NONE') headers.set('content-encoding', compression.toLowerCase());
  return { type, input, url: upstreamUrl(assignment.api_url, suffix), init: { method: 'POST', headers, body: compressBody(rawPayload, compression), signal, redirect: 'manual' } };
}
export async function executeProviderRequest(plan, fetchImpl) {
  if (plan.models) return listNativeModels(plan, fetchImpl);
  let upstream = await fetchImpl(plan.url, plan.init);
  if (plan.nativeMessages) return messagesResponse(upstream);
  if (plan.type === 'AWS_BEDROCK' && plan.init.method === 'POST' && /\/chat\/completions\/?$/.test(new URL(plan.url).pathname)) {
    const input = JSON.parse(plan.init.body);
    if (input.stream === true && (input.n === undefined || (Number.isSafeInteger(input.n) && input.n > 0)))
      upstream = bedrockChatResponse(upstream, input.n ?? 1);
  }
  if (plan.messagesBridge && !upstream.ok) return bridgeError(upstream, plan.type);
  if (['OPENAI_COMPATIBLE', 'OPENAI_ANTHROPIC', 'AWS_BEDROCK'].includes(plan.type)) return plan.messagesBridge ? chatToMessages(upstream, plan.bridgeInput) : upstream;
  if (!upstream.ok) return normalizeError(upstream, plan.type);
  const response = await (plan.type === 'ANTHROPIC' ? anthropicResponse(upstream, plan.input) : geminiResponse(upstream, plan.input));
  return plan.messagesBridge ? chatToMessages(response, plan.bridgeInput) : response;
}
async function listNativeModels(plan, fetchImpl) {
  const url = new URL(plan.url), data = [], seen = new Set(); let totalBytes = 0;
  for (let page = 0; page < 100; page++) {
    const upstream = await fetchImpl(new URL(url), plan.init);
    if (!upstream.ok) return normalizeError(upstream, plan.type);
    const payload = await readJson(upstream), anthropic = plan.type === 'ANTHROPIC';
    totalBytes += Buffer.byteLength(JSON.stringify(payload));
    if (totalBytes > 10 * 1024 * 1024) fail(502, 'invalid_model_list', 'Provider model list exceeds the supported size');
    const models = anthropic ? payload.data : payload.models;
    if (!Array.isArray(models)) fail(502, 'invalid_model_list', 'Invalid native model list');
    for (const model of models) {
      const id = anthropic ? model?.id : typeof model?.name === 'string' ? model.name.replace(/^models\//, '') : null;
      if (typeof id !== 'string' || !id) fail(502, 'invalid_model_list', 'Invalid native model ID');
      const created = anthropic && typeof model.created_at === 'string' ? Math.floor(Date.parse(model.created_at) / 1000) : 0;
      data.push({ id, object: 'model', created: Number.isFinite(created) ? created : 0, owned_by: anthropic ? 'anthropic' : 'google' });
    }
    const next = anthropic ? payload.has_more ? payload.last_id : null : payload.nextPageToken;
    if (anthropic && payload.has_more && !next) fail(502, 'invalid_model_list', 'Provider omitted its model pagination cursor');
    if (!next) return new Response(JSON.stringify({ object: 'list', data }), { status: 200, headers: safeHeaders(upstream) });
    if (typeof next !== 'string' || seen.has(next)) fail(502, 'invalid_model_list', 'Invalid model pagination cursor');
    seen.add(next); url.searchParams.set(anthropic ? 'after_id' : 'pageToken', next);
  }
  fail(502, 'invalid_model_list', 'Provider model pagination limit exceeded');
}
