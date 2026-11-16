import { fail } from '../errors.js';
import { modelAllowedByPolicies } from './model-policy.js';

// Only the model catalogue is buffered; inference responses retain their streaming path.
export async function filterModelList(upstream, policies, fallback, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  if (upstream.body) for await (const chunk of upstream.body) {
    size += chunk.length;
    if (size > limit) fail(502, 'invalid_model_list', 'Provider model list exceeds the supported size');
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(502, 'invalid_model_list', 'Provider returned an invalid model list'); }
  // Most providers expose the OpenAI `{ data: [{ id }] }` shape. A number
  // of otherwise OpenAI-compatible catalogues return `{ models: [...] }`;
  // accept that common variant too so admin discovery and routing see the
  // same model IDs instead of reporting an empty catalogue.
  if (payload && !Array.isArray(payload.data) && Array.isArray(payload.models)) {
    payload.data = payload.models.map(model => typeof model === 'string'
      ? { id: model }
      : model && typeof model.id === 'string' ? model
      : model && typeof model.name === 'string' ? { ...model, id: model.name.replace(/^models\//, '') }
      : model);
  }
  if (!payload || !Array.isArray(payload.data) || payload.data.some(model => !model || typeof model.id !== 'string' || !model.id)) {
    fail(502, 'invalid_model_list', 'Provider returned an invalid model list');
  }
  return { ...payload, data: payload.data.filter(model => modelAllowedByPolicies(model.id, policies, fallback)) };
}
