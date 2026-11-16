import { randomUUID } from 'node:crypto';
import { fail } from '../errors.js';
import { extractUsage } from '../services/usage.js';
import { validateChat, textParts, imageData, parseArguments, toolResult, invalid, number, finishReason, chatEnvelope, readJson, safeHeaders, sseEvents, streamResponse, chunk, object } from './native-common.js';

export function geminiRequest(input) {
  // OpenAI completion storage has no native Gemini equivalent.
  if (object(input)) { input = { ...input }; delete input.store; }
  const body = validateChat(input), contents = [], system = [], calls = new Map();
  if (body.parallel_tool_calls === false) invalid('Gemini adapter cannot enforce parallel_tool_calls=false');
  for (const message of body.messages) {
    const parts = textParts(message.content).map(part => part.type === 'text' ? { text: part.text } : { inlineData: imageData(part.image_url.url) });
    if (['system','developer'].includes(message.role)) {
      if (parts.some(part => part.inlineData)) invalid('System messages must contain text');
      system.push(...parts); continue;
    }
    let role = message.role === 'assistant' ? 'model' : 'user';
    if (message.role === 'tool') {
      const { name, nativeId } = toolResult(message, calls);
      let result; try { result = JSON.parse(message.content); } catch { result = message.content; }
      parts.splice(0, parts.length, { functionResponse: { name, ...(nativeId ? { id: nativeId } : {}), response: object(result) ? result : { result } } });
    }
    for (const call of message.tool_calls || []) {
      const nativeId = call.extra_content?.google?.function_call_id;
      if (nativeId !== undefined && typeof nativeId !== 'string') invalid('Invalid Gemini function call ID');
      calls.set(call.id, { name: call.function.name, nativeId });
      const signature = call.extra_content?.google?.thought_signature;
      if (signature !== undefined && typeof signature !== 'string') invalid('Invalid Gemini thought signature');
      parts.push({ functionCall: { name: call.function.name, ...(nativeId ? { id: nativeId } : {}), args: parseArguments(call.function.arguments) }, ...(signature ? { thoughtSignature: signature } : {}) });
    }
    if (!parts.length) invalid('Messages must have content or tool calls');
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (!contents.length) invalid('A conversation message is required');
  const result = { contents }, generationConfig = {};
  if (system.length) result.systemInstruction = { parts: system };
  for (const [source, target] of [['temperature','temperature'],['top_p','topP']]) if (body[source] !== undefined) generationConfig[target] = body[source];
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined) generationConfig.maxOutputTokens = max;
  if (body.stop !== undefined) generationConfig.stopSequences = typeof body.stop === 'string' ? [body.stop] : body.stop;
  if (body.response_format !== undefined) {
    if (body.response_format.type === 'json_object') generationConfig.responseMimeType = 'application/json';
    else if (body.response_format.type === 'json_schema' && object(body.response_format.json_schema?.schema)) {
      generationConfig.responseMimeType = 'application/json'; generationConfig.responseJsonSchema = body.response_format.json_schema.schema;
    } else if (body.response_format.type !== 'text') invalid('Unsupported Gemini response_format');
  }
  if (Object.keys(generationConfig).length) result.generationConfig = generationConfig;
  if (body.tools?.length) {
    result.tools = [{ functionDeclarations: body.tools.map(({ function: fn }) => ({ name: fn.name, ...(fn.description === undefined ? {} : { description: fn.description }), parametersJsonSchema: fn.parameters || { type: 'object', properties: {} } })) }];
    const choice = body.tool_choice || 'auto';
    result.toolConfig = { functionCallingConfig: typeof choice === 'object' ? { mode: 'ANY', allowedFunctionNames: [choice.function.name] } : { mode: { auto: 'AUTO', none: 'NONE', required: 'ANY' }[choice] } };
  }
  return result;
}
export function geminiUsage(usage) {
  if (!usage) return undefined;
  const output = number(usage.candidatesTokenCount), reasoning = number(usage.thoughtsTokenCount);
  return { prompt_tokens: number(usage.promptTokenCount), completion_tokens: output === null ? null : output + (reasoning ?? 0), total_tokens: number(usage.totalTokenCount),
    prompt_tokens_details: { cached_tokens: number(usage.cachedContentTokenCount) }, completion_tokens_details: { reasoning_tokens: reasoning } };
}
function candidateParts(value) {
  const candidate = value.candidates?.[0];
  if (value.promptFeedback?.blockReason) return { parts: [], finish: 'content_filter' };
  if (!candidate) {
    if (value.usageMetadata) return { parts: [], finish: null };
    fail(502, 'invalid_provider_response', 'Invalid Gemini candidate');
  }
  if (candidate.finishReason && !['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY'].includes(candidate.finishReason)) fail(502, 'upstream_generation_failed', 'Gemini could not complete the generation');
  const parts = candidate.content?.parts || [];
  if (!Array.isArray(parts)) fail(502, 'invalid_provider_response', 'Invalid Gemini content');
  if (parts.some(part => !part.thought && part.text === undefined && !part.functionCall)) fail(502, 'unsupported_provider_output', 'Gemini returned an unsupported output modality');
  return { parts: parts.filter(part => !part.thought), finish: candidate.finishReason ? finishReason(candidate.finishReason) : null };
}
function toolCall(part) {
  return { id: `call_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }, ...((part.thoughtSignature || part.functionCall.id) ? { extra_content: { google: { ...(part.thoughtSignature ? { thought_signature: part.thoughtSignature } : {}), ...(part.functionCall.id ? { function_call_id: part.functionCall.id } : {}) } } } : {}) };
}
export async function geminiResponse(upstream, input) {
  const envelope = chatEnvelope(input.model), state = { usage: null };
  if (input.stream) return streamResponse(upstream, geminiStream(upstream, input, envelope, state), state);
  const value = await readJson(upstream), { parts, finish } = candidateParts(value);
  if (!finish) fail(502, 'incomplete_response', 'Gemini response has no finish reason');
  const tools = parts.filter(part => part.functionCall).map(toolCall), text = parts.filter(part => typeof part.text === 'string').map(part => part.text).join('');
  const result = { ...envelope, id: value.responseId || envelope.id, model: value.modelVersion || input.model, choices: [{ index: 0, message: { role: 'assistant', content: text || (tools.length ? null : ''), ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: tools.length && finish === 'stop' ? 'tool_calls' : finish, logprobs: null }], usage: geminiUsage(value.usageMetadata) };
  const response = new Response(JSON.stringify(result), { status: upstream.status, headers: safeHeaders(upstream) });
  response.infergate = { usage: extractUsage(result) }; return response;
}
async function* geminiStream(upstream, input, envelope, state) {
  let started = false, finish = null, usage, toolCount = 0;
  for await (const value of sseEvents(upstream.body)) {
    if (value.error) { yield { error: { message: 'Gemini stream failed', type: 'server_error', code: 'upstream_stream_error', param: null } }; return; }
    if (!started) {
      started = true; envelope.id = value.responseId || envelope.id; envelope.model = value.modelVersion || input.model;
      yield chunk(envelope, { role: 'assistant', content: '' });
    }
    if (value.usageMetadata) usage = { ...usage, ...value.usageMetadata };
    state.usage = extractUsage({ model: envelope.model, usage: geminiUsage(usage) });
    const candidate = candidateParts(value);
    for (const part of candidate.parts) {
      if (typeof part.text === 'string' && part.text) yield chunk(envelope, { content: part.text });
      if (part.functionCall) yield chunk(envelope, { tool_calls: [{ index: toolCount++, ...toolCall(part) }] });
    }
    if (candidate.finish) finish = candidate.finish;
  }
  if (!started || !finish) fail(502, 'incomplete_stream', 'Gemini stream ended before completion');
  yield chunk(envelope, {}, toolCount && finish === 'stop' ? 'tool_calls' : finish);
  if (input.stream_options?.include_usage && usage) yield { ...envelope, object: 'chat.completion.chunk', choices: [], usage: geminiUsage(usage) };
  yield '[DONE]';
}
