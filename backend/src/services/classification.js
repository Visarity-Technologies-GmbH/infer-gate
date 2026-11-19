import { runRoleScript, updateScriptContext } from './role-script-runner.js';
import { decrypt } from '../security/credentials.js';
import { fail, HttpError } from '../errors.js';

const responseLimit = 1024 * 1024;
export function classificationPromptReplacement(messages, maxToken = null, { script, input, inputType = 'OPENAI', context = {}, signal, helpers, scriptTimeouts } = {}) {
  if (script != null) {
    return runRoleScript({ mode: 'prompt', script, input, inputType,
      limit: Math.floor((maxToken ?? 30000) * 0.9), context }, { signal, kind: 'prompt', helpers, scriptTimeouts }).then(result => {
      if (typeof result?.value !== 'string' || !result.context || typeof result.context !== 'object' || Array.isArray(result.context))
        fail(502, 'invalid_prompt_result', 'Prompt script must return a string and retain an object context');
      updateScriptContext(context, result.context, 'prompt');
      return JSON.stringify(result.value).slice(1, -1);
    });
  }
  const strippedMessages = messages
    .filter(message => ['system', 'user'].includes(message?.role))
    .map(({ tool_calls, reasoning_content, ...message }) => message);
  const limit = Math.floor((maxToken ?? 30000) * 0.9);
  let prompt = JSON.stringify(strippedMessages).slice(0, limit);
  // Avoid cutting a Unicode surrogate pair in half at the character boundary.
  if (/[\uD800-\uDBFF]$/.test(prompt)) prompt = prompt.slice(0, -1);
  return JSON.stringify(prompt).slice(1, -1);
}

export function classificationBody(template, messages, maxToken = null, promptReplacement) {
  // Replace inside JSON string literals with escaped JSON text, not an array.
  const serialized = JSON.stringify(JSON.parse(template));
  const replacement = promptReplacement ?? classificationPromptReplacement(messages, maxToken);
  return serialized.replaceAll('${PROMPT}', () => replacement);
}

export async function classifyMessages(db, handlerId, messages, config, { fetchImpl = fetch, signal, maxToken, promptReplacement, onRequest = async () => {}, onResult = async () => {} } = {}) {
  if (!Array.isArray(messages)) fail(400, 'invalid_messages', 'Messages must be an array');
  const [handler] = await db.query('SELECT api_url,encrypted_api_key,CAST(json_template AS CHAR) AS json_template,maxToken FROM classification_handlers WHERE id=?', [handlerId]);
  if (!handler) fail(503, 'classification_handler_unavailable', 'Assigned classification handler is unavailable');
  let response;
  try {
    const body = classificationBody(handler.json_template, messages, maxToken === undefined ? handler.maxToken : maxToken, promptReplacement);
    const credential = decrypt(handler.encrypted_api_key, config.encryptionKey);
    signal?.throwIfAborted();
    await onRequest(body);
    response = await fetchImpl(handler.api_url, {
      method: 'POST', redirect: 'error', signal,
      headers: new Headers({ authorization: `Bearer ${credential}`, 'content-type': 'application/json', accept: 'application/json' }),
      body,
    });
    const chunks = []; let size = 0;
    if (response.body) for await (const chunk of response.body) {
      signal?.throwIfAborted();
      size += chunk.length;
      if (size > responseLimit) fail(502, 'classification_response_too_large', 'Classification response exceeds the supported size');
      chunks.push(chunk);
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail(502, 'invalid_classification_response', 'Classification service returned invalid JSON'); }
    await onResult(result);
    if (!response.ok) fail(502, 'classification_http_error', 'Classification service request failed');
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (signal?.aborted) fail(504, 'classification_timeout', 'Classification request was aborted or timed out');
    fail(502, 'classification_failed', 'Classification service request failed');
  } finally {
    // Cancel bodies on oversized responses and interrupted reads.
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
