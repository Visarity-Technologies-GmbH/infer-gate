import test from 'node:test';
import assert from 'node:assert/strict';
import { runRoleScript } from '../src/services/role-script-runner.js';

const run = (script, helpers = {}) => runRoleScript({ mode: 'input', script,
  input: { model: 'test', messages: [] }, inputType: 'OPENAI', context: {} }, { helpers });

test('reported writeStringCache script completes after its helper reply', async () => {
  const calls = [];
  const result = await run(`async function updateInput(input, input_type, context) {
    try { await context.writeStringCache("test", "test"); } catch (error) {}
    return input;
  }`, { writeStringCache: async (...args) => { calls.push(args); return true; } });
  assert.deepEqual(calls, [['test', 'test']]);
  assert.deepEqual(result.value, { model: 'test', messages: [] });
});

test('sequential and concurrent helpers resume the script and preserve results', async () => {
  const values = new Map();
  const logs = [];
  const result = await run(`async function updateInput(input, type, context) {
    context.written = await context.writeStringCache('test', 'value');
    context.values = await Promise.all([context.readStringCache('test'), context.readStringCache('missing')]);
    await context.logDebug('script.txt', context.values[0]);
    context.hash = context.md5('abc');
    return input;
  }`, {
    writeStringCache: async (key, value) => { values.set(key, value); return true; },
    readStringCache: async key => values.get(key) ?? null,
    logDebug: async (...args) => { logs.push(args); return true; },
  });
  assert.deepEqual(result.context, { written: true, values: ['value', null], hash: '900150983cd24fb0d6963f7d28e17f72' });
  assert.deepEqual(logs, [['script.txt', 'value']]);
});

test('helper failures can be caught and unresolved helpers retain the deadline', async () => {
  const result = await run(`async function updateInput(input, type, context) {
    try { await context.writeStringCache('test', 'test'); }
    catch { context.caught = true; }
    return input;
  }`, { writeStringCache: async () => { throw new Error('private detail'); } });
  assert.equal(result.context.caught, true);
  await assert.rejects(run(`async function updateInput(input, type, context) {
    await context.readStringCache('test'); return input;
  }`, { readStringCache: () => new Promise(() => {}) }), { code: 'evaluation_timeout' });
});
