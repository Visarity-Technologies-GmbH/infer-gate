import test from 'node:test';
import assert from 'node:assert/strict';
import { classificationPromptReplacement, classificationBody } from '../src/services/classification.js';
import { classificationCacheKey } from '../src/services/classification-cache.js';
import { evaluateClassification } from '../src/services/evaluation.js';

test('custom prompts receive original input, protocol, limit and shared request context', async () => {
  for (const inputType of ['OPENAI', 'ANTHROPIC']) {
    for (const maxToken of [null, 11]) {
      const input = { system: 'native system', messages: [{ role: 'assistant', content: 'history' }], extra: 'original' };
      const context = {};
      const script = `async function prompt(input, input_type, limit, context) {
        context.seen = [input_type, limit, input.extra, input.system, input.messages[0].role];
        input.extra = 'modified';
        return 'quotes " slash \\\\ newline\\n 🌻 \${PROMPT} $&';
      }`;
      const replacement = await classificationPromptReplacement(input.messages, maxToken, { script, input, inputType, context });
      assert.deepEqual(context.seen, [inputType, Math.floor((maxToken ?? 30000) * 0.9), 'original', 'native system', 'assistant']);
      assert.equal(input.extra, 'original');
      const body = JSON.parse(classificationBody('{"prompt":"${PROMPT}","again":"${PROMPT}"}', input.messages, maxToken, replacement));
      assert.equal(body.prompt, 'quotes " slash \\ newline\n 🌻 ${PROMPT} $&');
      assert.equal(body.again, body.prompt);
      const result = await evaluateClassification(`async function evaluate(input, input_type, classification, models, context) {
        context.evaluated = true;
        return { category: context.seen[0], sensitiveData: false, models: null };
      }`, input, {}, [], { context });
      assert.equal(result.category, inputType);
      assert.equal(context.evaluated, true);
    }
  }
});

test('null scripts preserve legacy prompt; custom empty strings are not replaced by the default', async () => {
  const messages = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'removed' }];
  assert.equal(classificationPromptReplacement(messages, 10, { script: null }), classificationPromptReplacement(messages, 10));
  const replacement = await classificationPromptReplacement(messages, 1, { script: 'async function prompt() { return ""; }', input: { messages } });
  assert.equal(JSON.parse(classificationBody('{"prompt":"${PROMPT}"}', messages, 1, replacement)).prompt, '');
  const long = await classificationPromptReplacement(messages, 1, { script: 'async function prompt() { return "longer than limit"; }', input: { messages } });
  assert.equal(JSON.parse('"' + long + '"'), 'longer than limit');
});

test('custom prompt cache identity uses escaped output and protocol, not context or script source', () => {
  const role = { role_id: 1, classification_handler_id: 1, prompt_script: 'async function prompt() { return "x"; }' };
  const key = classificationCacheKey(role, [], 'ANTHROPIC', 'x', { a: 1 });
  assert.notEqual(key, classificationCacheKey(role, [], 'OPENAI', 'x', { a: 1 }));
  assert.notEqual(key, classificationCacheKey(role, [], 'ANTHROPIC', 'y', { a: 1 }));
  // Per-request context (e.g. request_id) must not split the cache.
  assert.equal(key, classificationCacheKey(role, [], 'ANTHROPIC', 'x', { a: 2, request_id: 'other' }));
  // Script edits still invalidate entries through the role's updated_at.
  assert.equal(key, classificationCacheKey({ ...role, prompt_script: role.prompt_script + '\n' }, [], 'ANTHROPIC', 'x', { a: 1 }));
  assert.notEqual(key, classificationCacheKey({ ...role, role_updated_at: '2026-11-16T00:00:00Z' }, [], 'ANTHROPIC', 'x', { a: 1 }));
});

test('prompt failures and unsafe access are sanitized and bounded', async () => {
  for (const script of [
    'async function prompt() { throw new Error("private detail"); }',
    'async function prompt() { return 1; }',
    'function prompt() { return "synchronous"; }',
    'function different() { return "missing"; }',
    'async function prompt() { return process.env.SECRET; }',
    'async function prompt() { return require("node:fs").readFileSync("/etc/passwd"); }',
    'async function prompt() { return Function("return process")(); }',
    'async function prompt() { return "x".repeat(300000); }',
    'async function prompt(i, t, l, c) { c.self = c; return "x"; }',
  ]) {
    await assert.rejects(classificationPromptReplacement([], null, { script, input: {} }), error => {
      assert.equal(error.status, 502);
      assert(!error.message.includes('private detail'));
      return true;
    });
  }
  await assert.rejects(classificationPromptReplacement([], null, { script: 'async function prompt() { while(true) {} }', input: {} }), { status: 504, code: 'prompt_timeout' });
  const controller = new AbortController();
  const pending = classificationPromptReplacement([], null, { script: 'async function prompt() { while(true) {} }', input: {}, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { status: 504, code: 'prompt_timeout' });
});

test('context is isolated between calls and prototype keys remain plain data', async () => {
  const script = 'async function prompt(i,t,l,c) { c.count = (c.count || 0) + 1; c["__proto__"] = null; return String(c.count); }';
  for (let i = 0; i < 2; i++) {
    const context = {};
    assert.equal(await classificationPromptReplacement([], null, { script, input: {}, context }), '1');
    assert.equal(context.count, 1);
    assert.equal(Object.getPrototypeOf(context), Object.prototype);
  }
});

test('async prompts await continuations and preserve their context mutations', async () => {
  for (const script of [
    'async function prompt(i,t,l,c) { await Promise.resolve(); await Promise.resolve(); c.done = true; return "ready"; }',
    'function prompt(i,t,l,c) { return Promise.resolve().then(() => { c.done = true; return "ready"; }); }',
  ]) {
    const context = {};
    assert.equal(await classificationPromptReplacement([], null, { script, input: {}, context }), 'ready');
    assert.equal(context.done, true);
  }
});

test('rejected promises and plain thenables fail; pending promises and continuation loops time out', async () => {
  for (const script of [
    'async function prompt() { await Promise.resolve(); throw new Error("private details"); }',
    'function prompt() { return { then(resolve) { resolve("value"); } }; }',
  ]) await assert.rejects(classificationPromptReplacement([], null, { script, input: {} }), { status: 502, code: 'prompt_failed' });
  for (const script of [
    'function prompt() { return new Promise(() => {}); }',
    'async function prompt() { await Promise.resolve(); while (true) {} }',
    'async function prompt() { while (true) { await Promise.resolve(); } }',
  ]) await assert.rejects(classificationPromptReplacement([], null, { script, input: {} }), { status: 504, code: 'prompt_timeout' });
});
