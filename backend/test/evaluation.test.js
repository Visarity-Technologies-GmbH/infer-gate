import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClassification, validateEvaluationResult } from '../src/services/evaluation.js';

test('evaluation receives JSON inputs and models, defaults correctly and cannot mutate the caller', async () => {
  const input = { model: 'model-a', messages: [{ content: 'private' }] };
  const classification = { category: 'finance', sensitive: true };
  const script = `async function evaluate(input, input_type, classification, models, context) {
    input.messages[0].content = 'changed';
    return { category: classification.category, sensitiveData: classification.sensitive, complexity: 2, models: models };
  }`;
  assert.deepEqual(await evaluateClassification(script, input, classification, ['model-a', 'model-b']), { category: 'finance', sensitiveData: true, complexity: 2, models: ['model-a', 'model-b'] });
  assert.equal(input.messages[0].content, 'private');
  assert.deepEqual(await evaluateClassification(null, input, classification, []), { category: 'other', sensitiveData: false, complexity: 0, models: null });
});

test('evaluation result schema rejects missing fields and wrong types; false is preserved', () => {
  const result = { category: '', sensitiveData: false, complexity: 0, models: null };
  assert.deepEqual(validateEvaluationResult(result), result);
  for (const value of [null, [], {}, { ...result, category: 12 }, { ...result, category: 'a'.repeat(256) }, { ...result, sensitiveData: null }, { ...result, sensitiveData: 1 }, { ...result, models: 'model-a' }, { ...result, models: [1] }])
    assert.throws(() => validateEvaluationResult(value), { status: 502, code: 'invalid_evaluation_result' });
});

test('script failures, non-Promise results and forbidden globals fail safely', async () => {
  for (const source of [
    'function evaluate() { throw new Error("private secret details"); }',
    'function evaluate() { return process.env; }',
    'function evaluate() { return require("node:fs").readFileSync("/etc/passwd"); }',
    'function evaluate() { return Function("return process")(); }',
    'function evaluate() { return this.constructor.constructor("return process")(); }',
    'async function evaluate() { return { category: "a", sensitiveData: "yes", models: null }; }',
    'function evaluate() { return { category: "a", sensitiveData: false, models: null }; }',
    'function evaluate() { return { then(resolve) { resolve({ category: "a", sensitiveData: false, models: null }); } }; }',
    'async function evaluate() { throw new Error("private secret details"); }',
    'function evaluate() { return Promise.reject("private secret details"); }',
  ]) {
    await assert.rejects(evaluateClassification(source, {}, {}, []), error => {
      assert.equal(error.status, 502);
      assert(!error.message.includes('private secret'));
      return true;
    });
  }
});

test('infinite loops and abort signals stop evaluation', async () => {
  await assert.rejects(evaluateClassification('function evaluate() { while (true) {} }', {}, {}, []), { status: 504, code: 'evaluation_timeout' });
  const controller = new AbortController();
  const pending = evaluateClassification('function evaluate() { while (true) {} }', {}, {}, [], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { status: 504, code: 'evaluation_timeout' });
});

test('complexity preserves each level, supports legacy scripts, and rejects invalid values', () => {
  const result = { category: 'other', sensitiveData: false, models: null };
  assert.equal(validateEvaluationResult(result).complexity, null);
  for (const complexity of [null, 0, 1, 2])
    assert.equal(validateEvaluationResult({ ...result, complexity }).complexity, complexity);
  for (const complexity of [-1, 3, 0.5, '1', true, {}, NaN, Infinity])
    assert.throws(() => validateEvaluationResult({ ...result, complexity }), { code: 'invalid_evaluation_result' });
});


test('evaluation waits for async continuations and explicit Promise chains', async () => {
  for (const script of [
    'async function evaluate() { await Promise.resolve(); await Promise.resolve(); return { category: "async", sensitiveData: false, models: null }; }',
    'function evaluate() { return new Promise(resolve => resolve()).then(() => ({ category: "async", sensitiveData: false, models: null })); }',
  ]) assert.deepEqual(await evaluateClassification(script, {}, {}, []), { category: 'async', sensitiveData: false, complexity: null, models: null });
});

test('pending Promises and loops in Promise continuations time out', async () => {
  for (const script of [
    'function evaluate() { return new Promise(() => {}); }',
    'async function evaluate() { await Promise.resolve(); while (true) {} }',
    'async function evaluate() { while (true) { await Promise.resolve(); } }',
  ]) await assert.rejects(evaluateClassification(script, {}, {}, []), { status: 504, code: 'evaluation_timeout' });
});


test('evaluation receives the protocol second and shared context fifth for both protocols', async () => {
  for (const inputType of ['ANTHROPIC', 'OPENAI']) {
    const context = { fromPrompt: 'shared' };
    const script = `async function evaluate(input, input_type, classification, models, context,) {
      await Promise.resolve();
      if (input.model !== 'original' || classification.category !== 'classified' || context.fromPrompt !== 'shared')
        throw new Error('Wrong argument order');
      context.fromEvaluation = input_type;
      return { category: input_type, sensitiveData: false, models };
    }`;
    const result = await evaluateClassification(script, { model: 'original' }, { category: 'classified' }, ['available'], { inputType, context });
    assert.equal(result.category, inputType);
    assert.deepEqual(result.models, ['available']);
    assert.deepEqual(context, { fromPrompt: 'shared', fromEvaluation: inputType });
  }
});
