import test from 'node:test';
import assert from 'node:assert/strict';
import { transformOutputStream } from '../src/services/output-stream.js';

async function* chunks(text, size = 1) {
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}
async function collect(stream) { let text = ''; for await (const chunk of stream) text += chunk; return text; }
const script = 'async function updateOutput(output, type, context) { await Promise.resolve(); context.count = (context.count || 0) + 1; output.count = context.count; output.protocol = type; return output; }';

test('stream output handles split UTF-8/CRLF, multiline data, metadata, keepalives and DONE', async () => {
  const context = {}, originals = [];
  const output = await collect(transformOutputStream(chunks(': ping\r\n\r\nevent: message\r\nid: 7\r\nretry: 10\r\ndata: {"text":\r\ndata: "🌻"}\r\n\r\ndata: {"text":"next"}\r\n\r\ndata: [DONE]\r\n\r\n'), script, 'OPENAI', context, { onOriginal: value => originals.push(value) }));
  assert(output.startsWith(': ping\n\nevent: message\nid: 7\nretry: 10\n'));
  assert(output.endsWith('data: [DONE]\n\n'));
  const events = output.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(events.map(value => value.count), [1, 2]);
  assert.equal(events[0].text, '🌻');
  assert.equal(events[0].protocol, 'OPENAI');
  assert.deepEqual(originals, [{ text: '🌻' }, { text: 'next' }]);
  assert.equal(context.count, 2);
});

test('bare CR event boundaries and final CR are supported', async () => {
  const output = await collect(transformOutputStream(chunks('event: ping\rdata: {"type":"ping"}\r\r'), script, 'ANTHROPIC', {}));
  assert(output.startsWith('event: ping\ndata: '));
  assert(output.includes('"protocol":"ANTHROPIC"'));
});

test('stream transformation is incremental and cancels source on early termination', async () => {
  let pulled = 0, closed = false;
  async function* source() {
    try { pulled++; yield Buffer.from('data: {"first":true}\n\n'); pulled++; yield Buffer.from('data: {"second":true}\n\n'); }
    finally { closed = true; }
  }
  const stream = transformOutputStream(source(), script, 'OPENAI', {});
  const first = await stream.next();
  assert(first.value.toString().includes('"first":true'));
  assert.equal(pulled, 1);
  await stream.return();
  assert.equal(closed, true);
  assert.equal(pulled, 1);
});

test('bad, oversized and incomplete events fail; script failure stops before DONE', async () => {
  for (const text of ['data: bad\n\n', 'data: []\n\n', 'data: {"unfinished":true}', 'data: ' + 'x'.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(collect(transformOutputStream(chunks(text, 65536), script, 'OPENAI', {})), { status: 502 });
  }
  const original = [];
  await assert.rejects(collect(transformOutputStream(chunks('data: {}\n\ndata: [DONE]\n\n', 65536), 'async function updateOutput() { throw new Error("private"); }', 'OPENAI', {}, { onOriginal: value => original.push(value) })), { code: 'output_script_failed' });
  assert.deepEqual(original, [{}]);
});

test('OpenAI completion and trailing usage are delivered with DONE, without buffering content', async () => {
  const source = [
    'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"total_tokens":3}}\n\n',
    'data: [DONE]\n\n',
  ];
  async function* body() { for (const frame of source) yield Buffer.from(frame); }
  const iterator = transformOutputStream(body(), 'async function updateOutput(output) { return output; }', 'OPENAI', {});
  const content = await iterator.next();
  assert(content.value.toString().includes('Hi'));
  const completion = await iterator.next();
  assert(completion.value.toString().includes('"finish_reason":"stop"'));
  assert(completion.value.toString().includes('"total_tokens":3'));
  assert(completion.value.toString().endsWith('data: [DONE]\n\n'));
});

test('a missing DONE after finish_reason is not emitted as successful completion', async () => {
  const text = 'data: {"choices":[{"finish_reason":"stop"}]}\n\n';
  const iterator = transformOutputStream(chunks(text), 'async function updateOutput(output) { return output; }', 'OPENAI', {});
  await assert.rejects(iterator.next(), { code: 'incomplete_stream' });
});
