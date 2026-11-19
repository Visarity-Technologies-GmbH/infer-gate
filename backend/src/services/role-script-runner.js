import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { fail, HttpError } from '../errors.js';
import { fetchJson } from './script-fetch-json.js';

const workerPath = fileURLToPath(new URL('./evaluation-worker.js', import.meta.url));
export async function runRoleScript(payload, { signal, kind = "evaluation", helpers = {}, scriptTimeouts = {} } = {}) {
  if (signal?.aborted) fail(504, `${kind}_timeout`, `${kind} was aborted or timed out`);
  const result = await new Promise((resolve, reject) => {
    const helperController = new AbortController();
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${workerPath}`, '--max-old-space-size=64', workerPath], {
      env: {}, stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
    });
    let output = '', settled = false;
    let pendingFetches = 0, remainingMs = 1000, budgetStarted = performance.now();
    const decoder = new StringDecoder('utf8');
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(totalTimer); signal?.removeEventListener('abort', abort);
      helperController.abort();
      child.kill('SIGKILL');
      error ? reject(error) : resolve(result);
    };
    const abort = () => finish(new HttpError(504, `${kind}_timeout`, `${kind} was aborted or timed out`));
    let timer = setTimeout(abort, remainingMs); timer.unref();
    const totalTimer = setTimeout(abort, scriptTimeouts.totalMs ?? 300000); totalTimer.unref();
    const fetchWithDeadline = async (object, apiUrl, bearerToken) => {
      if (pendingFetches++ === 0) {
        remainingMs -= performance.now() - budgetStarted;
        clearTimeout(timer);
        if (remainingMs <= 0) abort();
      }
      const fetchController = new AbortController();
      const fetchTimer = setTimeout(() => fetchController.abort(new Error('fetchJson timed out')), scriptTimeouts.fetchMs ?? 60000);
      fetchTimer.unref();
      try {
        return await fetchJson(object, apiUrl, bearerToken, AbortSignal.any([helperController.signal, fetchController.signal]));
      } finally {
        clearTimeout(fetchTimer);
        if (--pendingFetches === 0 && !settled) {
          budgetStarted = performance.now();
          timer = setTimeout(abort, remainingMs); timer.unref();
        }
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(new HttpError(502, `${kind}_failed`, `${kind} script failed`)));
    child.stdin.on('error', () => {});
    child.on('message', message => {
      if (settled || !message?.rpc) return;
      Promise.resolve().then(async () => {
        const fn = message.rpc === 'fetchJson'
          ? fetchWithDeadline
          : ['logDebug', 'readStringCache', 'writeStringCache'].includes(message.rpc) && Object.hasOwn(helpers, message.rpc) ? helpers[message.rpc] : null;
        if (!fn || !Array.isArray(message.args) || Buffer.byteLength(JSON.stringify(message.args)) > 32768) throw new Error('Invalid helper call');
        return fn(...message.args);
      }).then(value => { if (!settled) child.send({ reply: message.id, value }); }, error => {
        if (!settled) child.send({ reply: message.id, error: message.rpc === 'fetchJson'
          ? { message: error.message, status: error.status, response: error.response }
          : true });
      });
    });
    child.stdout.on('data', chunk => {
      output += decoder.write(chunk);
      if (Buffer.byteLength(output) > 524288) finish(new HttpError(502, `invalid_${kind}_result`, `${kind} output exceeds the supported size`));
    });
    child.on('close', code => {
      if (settled) return;
      output += decoder.end();
      let message;
      try { message = JSON.parse(output); } catch { /* Never expose worker diagnostics. */ }
      if (code !== 0 || !message || message.error) {
        const timeout = message?.error === 'evaluation_timeout';
        finish(new HttpError(timeout ? 504 : 502, timeout ? `${kind}_timeout` : `${kind}_failed`, timeout ? `${kind} timed out` : `${kind} script failed`));
      } else finish(null, message.result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
  return result;
}


// Context crosses the process boundary as bounded JSON, never as host objects.
export function updateScriptContext(context, value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(502, `invalid_${kind}_result`, 'Script context must remain a JSON object');
  for (const key of Object.keys(context)) delete context[key];
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(context, key, { value: item, enumerable: true, configurable: true, writable: true });
}
