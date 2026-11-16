import test from 'node:test';
import assert from 'node:assert/strict';
import { classificationCacheKey } from '../src/services/classification-cache.js';
import { updateRequestInput } from '../src/services/input-script.js';

test('input scripts resolve objects and share JSON context without mutating the caller', async () => {
  const input = { model: 'test', messages: [] }, context = { a: 1 };
  const result = await updateRequestInput('async function updateInput(input, type, context) { await Promise.resolve(); context.a++; input.type = type; return input; }', input, 'OPENAI', context, { bodyLimit: 1000 });
  assert.deepEqual(result.input, { ...input, type: 'OPENAI' });
  assert.deepEqual(JSON.parse(result.body), result.input);
  assert.equal(input.type, undefined);
  assert.deepEqual(context, { a: 2 });
});

test('input scripts reject invalid outputs, unsafe access, sync returns, and timeouts', async () => {
  for (const script of [
    'async function updateInput() { return null; }',
    'async function updateInput() { return "bad"; }',
    'async function updateInput() { return []; }',
    'function updateInput() { return {}; }',
    'async function updateInput() { return process.env; }',
    'async function updateInput() { throw new Error("private"); }',
    'async function updateInput(input) { input.self = input; return input; }',
    'async function updateInput() { return { data: "x".repeat(300000) }; }',
  ]) await assert.rejects(updateRequestInput(script, {}, 'OPENAI', {}, { bodyLimit: 10000 }), error => error.status === 502 && !error.message.includes('private'));
  await assert.rejects(updateRequestInput('async function updateInput() { await Promise.resolve(); while(true) {} }', {}, 'OPENAI', {}), { status: 504 });
  const controller = new AbortController();
  const pending = updateRequestInput('async function updateInput() { return new Promise(() => {}); }', {}, 'OPENAI', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { status: 504 });
});


test('classification context cache separates full request inputs even when reduced prompts match', () => {
  const role = { role_id: 1, classification_handler_id: 2, input_script: 'async function updateInput(input) { return input; }' };
  const key = input => classificationCacheKey(role, [], 'OPENAI', 'same prompt', {}, input);
  assert.notEqual(key({ temperature: 0 }), key({ temperature: 1 }));
  assert.equal(key({ temperature: 0 }), key({ temperature: 0 }));
});
