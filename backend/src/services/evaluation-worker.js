// Dedicated, permission-restricted process: no application secrets or host objects
// enter the script context. The parent also enforces a wall-clock deadline.
import { Script, createContext } from 'node:vm';
import { createHash } from 'node:crypto';
let input = '';
for await (const chunk of process.stdin) input += chunk;
try {
  const payload = JSON.parse(input);
  let sequence = 0;
  let context;
  const pending = new Map();
  const rpc = (name, ...args) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    process.send({ rpc: name, id, args });
  });
  process.on('message', message => {
    const call = pending.get(message?.reply);
    if (call) {
      pending.delete(message.reply);
      if (message.error) call.reject(new Error('Script helper failed'));
      else call.resolve(message.value);
    }
  });
  const sandbox = Object.create(null);
  Object.assign(sandbox, {
    __logDebug: (file, text) => rpc('logDebug', file, text),
    __readStringCache: key => rpc('readStringCache', key),
    __writeStringCache: (key, value) => rpc('writeStringCache', key, value),
    __md5: value => createHash('md5').update(String(value)).digest('hex'),
  });
  context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate' });
  // Synchronous execution is bounded by the VM deadline; async work is bounded
  // by the parent process deadline so RPC helper promises can resolve.
  const args = payload.mode === 'prompt'
    ? [payload.input, payload.inputType, payload.limit, payload.context]
    : ['input', 'output'].includes(payload.mode) ? [payload.input, payload.inputType, payload.context]
    : [payload.input, payload.inputType, payload.classification, payload.models, payload.context];
  const contextIndex = ['input', 'output'].includes(payload.mode) ? 2 : payload.mode === 'prompt' ? 3 : 4;
  const source = `"use strict";
${payload.script}
;(() => {
    const then = Promise.prototype.then;
    const stringify = JSON.stringify;
    const state = { output: null };
    const args = JSON.parse(${JSON.stringify(JSON.stringify(args))});
    args[${contextIndex}] = Object.assign(args[${contextIndex}], {
      logDebug: (file, text) => __logDebug(file, text), readStringCache: key => __readStringCache(key),
      writeStringCache: (key, value) => __writeStringCache(key, value), md5: value => __md5(value)
    });
    const value = ${payload.mode === 'prompt' ? 'prompt' : payload.mode === 'input' ? 'updateInput' : payload.mode === 'output' ? 'updateOutput' : 'evaluate'}(...args);
    const pack = value => stringify({ result: { value, context: args[${contextIndex}] } });
    const promise = value;
    // Native Promise.then rejects synchronous values and plain thenables.
    then.call(promise,
      result => { state.output = pack(result); },
      () => { state.output = stringify({ error: 'evaluation_failed' }); }
    );
    return state;
  })()`;
  const state = new Script(source).runInContext(context, { timeout: 200 });
  const drain = new Script('void 0');
  while (state.output === null) {
    // Allow IPC replies and host Promise jobs to run, then drain the VM's
    // continuation queue under its execution limit. The parent owns the total deadline.
    await new Promise(resolve => setTimeout(resolve, 1));
    drain.runInContext(context, { timeout: 200 });
  }
  if (typeof state.output !== 'string' || Buffer.byteLength(state.output) > 262144) throw new Error('Invalid evaluation output');
  process.stdout.write(state.output + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'evaluation_timeout' : 'evaluation_failed' }) + '\n');
} finally {
  if (process.connected) process.disconnect();
}
