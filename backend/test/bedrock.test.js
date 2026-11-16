import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { BEDROCK_REGIONS, bedrockBaseUrl, validateRegion } from '../src/providers/bedrock.js';
import { prepareProviderRequest, executeProviderRequest } from '../src/providers/index.js';
import { encrypt } from '../src/security/credentials.js';

const config = { encryptionKey: randomBytes(32) };
const req = { method: 'POST', url: '/chat/completions', get: name => ({ authorization: 'Bearer pak_secret', 'content-type': 'application/json', 'x-aws-region': 'us-west-2' })[name] };
function assignment(aws_region) { return { api_type: 'AWS_BEDROCK', aws_region, api_url: 'https://untrusted.example/ignored', encrypted_api_key: encrypt('bedrock-secret', config.encryptionKey) }; }

test('Bedrock endpoints use each key region, never a client header or provider URL', () => {
  const body = Buffer.from('{"model":"aws-model","stream":true}');
  for (const region of ['eu-central-1','us-east-1']) {
    const plan = prepareProviderRequest(assignment(region), req, body, config, new AbortController().signal);
    assert.equal(plan.url.href, `https://bedrock-mantle.${region}.api.aws/v1/chat/completions`);
    assert.equal(plan.init.headers.get('authorization'), 'Bearer bedrock-secret');
    assert.equal(plan.init.headers.get('x-aws-region'), null);
    assert.deepEqual(JSON.parse(plan.init.body), { model: 'aws-model', stream: true, stream_options: { include_usage: true } });
    assert.equal(plan.init.redirect, 'manual');
  }
});

test('Bedrock rejects absent, unsupported and injected regions before a request is sent', () => {
  for (const region of [undefined, null, '', 'us-east-1.evil.example', '../us-east-1', 'US-EAST-1', 'us-west-1']) {
    assert.throws(() => prepareProviderRequest(assignment(region), req, Buffer.alloc(0), config), { code: 'invalid_aws_region' });
  }
  for (const entry of BEDROCK_REGIONS) { assert.equal(validateRegion(entry.id), entry.id); assert.equal(new URL(bedrockBaseUrl(entry.id)).protocol, 'https:'); }
});

test('Bedrock forwards model lists, streams and upstream errors without response transformations', async () => {
  for (const [path, method, response] of [
    ['/models', 'GET', Response.json({ object: 'list', data: [{ id: 'aws-model' }] })],
    ['/chat/completions', 'POST', new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })],
    ['/responses', 'POST', Response.json({ error: { message: 'quota' } }, { status: 429, headers: { 'retry-after': '5' } })]
  ]) {
    const plan = prepareProviderRequest(assignment('eu-west-1'), { ...req, url: path, method }, Buffer.from('{}'), config);
    assert.equal(plan.url.href, `https://bedrock-mantle.eu-west-1.api.aws/v1${path}`);
    assert.equal(await executeProviderRequest(plan, async () => response), response);
  }
});

const nativeInput = { model: 'anthropic.claude-opus-4-7', max_tokens: 100, messages: [{ role: 'user', content: 'Hello' }], thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }] };
function messagesPlan(region, body = nativeInput, url = '/messages?beta=true') {
  return prepareProviderRequest(assignment(region), { ...req, url, headers: { authorization: 'Bearer pak_secret', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'test-beta', 'x-aws-region': 'us-west-2' }, get: name => ({ 'content-type': 'application/json', authorization: 'Bearer pak_secret', 'x-api-key': 'pak_secret', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'test-beta', 'x-aws-region': 'us-west-2' })[name] }, Buffer.from(JSON.stringify(body)), config);
}

test('Bedrock Anthropic Messages preserves effort, adaptive thinking and tools on the native regional route', () => {
  for (const region of ['us-east-1','eu-central-1']) {
    const plan = messagesPlan(region);
    assert.equal(plan.url.href, `https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages?beta=true`);
    assert.equal(plan.type, 'AWS_BEDROCK'); assert.equal(plan.nativeMessages, true); assert.equal(plan.messagesBridge, undefined);
    assert.deepEqual(JSON.parse(plan.init.body), nativeInput); assert.equal(plan.init.headers.get('x-api-key'), 'bedrock-secret');
    assert.equal(plan.init.headers.get('authorization'), null); assert.equal(plan.init.headers.get('x-aws-region'), null);
    assert.equal(plan.init.headers.get('anthropic-beta'), 'test-beta'); assert.equal(plan.init.headers.get('anthropic-version'), '2023-06-01'); assert.equal(plan.init.redirect, 'manual');
  }
  for (const region of [undefined, null, 'us-east-1.evil.example', '../us-east-1']) assert.throws(() => messagesPlan(region), { code: 'invalid_aws_region' });
});

test('Bedrock native Anthropic responses keep JSON/SSE thinking, tool blocks and errors in native format', async () => {
  const message = { id: 'msg_bedrock', type: 'message', role: 'assistant', model: nativeInput.model, content: [{ type: 'thinking', thinking: 'Reason', signature: 'opaque' }, { type: 'tool_use', id: 'call_test', name: 'lookup', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 5, output_tokens: 4 } };
  const response = await executeProviderRequest(messagesPlan('us-east-1'), async () => Response.json(message));
  assert.deepEqual(await response.json(), message);
  const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reason' } }, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } }, { type: 'message_stop' }];
  const streaming = await executeProviderRequest(messagesPlan('us-east-1', { ...nativeInput, stream: true }), async () => new Response(events.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }));
  const text = await streaming.text(); assert.match(text, /thinking_delta/); assert.match(text, /event: message_stop/); assert(!text.includes('[DONE]'));
  const failed = await executeProviderRequest(messagesPlan('us-east-1'), async () => Response.json({ error: { type: 'invalid_request_error', message: 'private provider diagnostics' } }, { status: 400 }));
  assert.equal(failed.status, 400); const error = await failed.json(); assert.equal(error.type, 'error'); assert(!JSON.stringify(error).includes('private provider diagnostics'));
});

test('Bedrock Anthropic token counting uses the native endpoint; other models keep chat translation', () => {
  const { max_tokens, ...body } = nativeInput;
  const count = messagesPlan('us-east-1', body, '/messages/count_tokens');
  assert.equal(count.url.href, 'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1/messages/count_tokens'); assert.equal(count.nativeMessages, true);
  const chat = messagesPlan('us-east-1', { model: 'openai.gpt-oss-120b', max_tokens: 10, messages: nativeInput.messages });
  assert.equal(chat.url.href, 'https://bedrock-mantle.us-east-1.api.aws/v1/chat/completions'); assert.equal(chat.messagesBridge, true); assert.equal(chat.init.headers.get('authorization'), 'Bearer bedrock-secret');
});

const chatEvent = (finish_reason = null, index = 0) => ({ choices: [{ index, delta: { content: 'Hello' }, finish_reason }] });
const usageEvent = { choices: [], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
async function mantleStream(text, options = {}) {
  const plan = prepareProviderRequest(assignment('us-east-1'), req, Buffer.from(JSON.stringify({ model: 'test', stream: true, ...options })), config);
  return executeProviderRequest(plan, async () => new Response(text, { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-test' } }));
}

test('Bedrock repairs clean EOF after finished choices and final usage, including output scripts', async () => {
  const { transformOutputStream } = await import('../src/services/output-stream.js');
  const { UsageCollector } = await import('../src/services/usage.js');
  const response = await mantleStream(frame(chatEvent()) + frame(chatEvent('stop')) + frame(usageEvent));
  assert.equal(response.headers.get('x-request-id'), 'upstream-test');
  const collector = new UsageCollector('text/event-stream');
  async function* original() { for await (const chunk of response.body) { collector.push(chunk); yield chunk; } }
  let text = '';
  for await (const chunk of transformOutputStream(original(), 'async function updateOutput(output) { return output; }', 'OPENAI', {})) text += chunk;
  collector.finish();
  assert.match(text, /"finish_reason":"stop"/);
  assert.equal(text.split('[DONE]').length, 2);
  assert.equal(collector.terminal, true);
  assert.equal(collector.usage.total_tokens, 3);
});

test('Bedrock accepts normal and unframed DONE without duplicating it', async () => {
  for (const ending of ['data: [DONE]\n\n', 'data: [DONE]', 'data: [DONE]\r\n']) {
    const response = await mantleStream(frame(chatEvent('stop')) + frame(usageEvent) + ending);
    assert.equal((await response.text()).split('[DONE]').length, 2);
  }
});

test('Bedrock does not repair missing finish/usage, invalid counts, errors or truncated frames', async () => {
  for (const text of [
    frame(chatEvent()), frame(chatEvent('stop')), frame(usageEvent),
    frame(chatEvent('stop')) + frame({ ...usageEvent, usage: { total_tokens: 3 } }),
    frame(chatEvent('stop')) + frame(usageEvent) + 'data: {',
    frame(chatEvent('stop')) + frame(usageEvent) + 'data: [DON',
    frame({ error: { message: 'failed' } }) + frame(chatEvent('stop')) + frame(usageEvent),
    frame(chatEvent('stop')) + frame(usageEvent) + frame(chatEvent()),
  ]) {
    const response = await mantleStream(text);
    await assert.rejects(response.text(), { code: 'incomplete_stream' });
  }
  const response = await mantleStream(frame(chatEvent('stop')) + frame(usageEvent), { n: 2 });
  await assert.rejects(response.text(), { code: 'incomplete_stream' });
  const complete = await mantleStream(frame(chatEvent('stop', 0)) + frame(chatEvent('length', 1)) + frame(usageEvent), { n: 2 });
  assert.match(await complete.text(), /\[DONE\]/);
});

test('Bedrock preserves transport failures after final usage and propagates cancellation', async () => {
  const { bedrockChatResponse } = await import('../src/providers/bedrock.js');
  let step = 0;
  const source = new ReadableStream({ pull(controller) {
    if (step++ === 0) controller.enqueue(Buffer.from(frame(chatEvent('stop')) + frame(usageEvent)));
    else controller.error(new Error('connection interrupted'));
  } }, { highWaterMark: 0 });
  await assert.rejects(bedrockChatResponse(new Response(source, { headers: { 'content-type': 'text/event-stream' } })).text(), /connection interrupted/);
  let cancelled = false;
  const body = new ReadableStream({ pull(controller) { controller.enqueue(Buffer.from(frame(chatEvent()))); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const reader = bedrockChatResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } })).body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
});
