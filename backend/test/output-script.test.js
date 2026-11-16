import test from 'node:test';
import assert from 'node:assert/strict';
import { updateResponseOutput } from '../src/services/output-script.js';

test('output scripts await JSON objects and share context without mutating accounting input', async () => {
  const output = { usage: { total_tokens: 5 }, choices: [] }, context = { flag: 'input' };
  const result = await updateResponseOutput('async function updateOutput(output, type, context) { await Promise.resolve(); output.type = type; output.flag = context.flag; output.usage.total_tokens = 999; context.done = true; return output; }', output, 'OPENAI', context);
  assert.deepEqual(JSON.parse(result), { usage: { total_tokens: 999 }, choices: [], type: 'OPENAI', flag: 'input' });
  assert.equal(output.usage.total_tokens, 5);
  assert.equal(context.done, true);
});

test('output scripts reject invalid results, unsafe code, timeout and cancellation', async () => {
  for (const script of [
    'async function updateOutput() { return null; }',
    'async function updateOutput() { return []; }',
    'async function updateOutput() { return "bad"; }',
    'function updateOutput() { return {}; }',
    'async function updateOutput() { return process.env; }',
    'async function updateOutput() { throw new Error("private"); }',
    'async function updateOutput(output) { output.self = output; return output; }',
    'async function updateOutput() { return { data: "x".repeat(300000) }; }',
  ]) await assert.rejects(updateResponseOutput(script, {}, 'OPENAI', {}), error => error.status === 502 && !error.message.includes('private'));
  await assert.rejects(updateResponseOutput('async function updateOutput() { await Promise.resolve(); while(true) {} }', {}, 'OPENAI', {}), { status: 504 });
  const controller = new AbortController();
  const pending = updateResponseOutput('async function updateOutput() { return new Promise(() => {}); }', {}, 'OPENAI', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { status: 504 });
});
