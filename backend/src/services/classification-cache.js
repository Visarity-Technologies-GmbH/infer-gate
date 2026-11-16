import { createHash } from 'node:crypto';
import { classificationPromptReplacement } from './classification.js';
import { createJsonCache } from './redis-cache.js';
import { DEFAULT_EVALUATION_SCRIPT } from './evaluation-script.js';

export function classificationCacheKey(role, messages, protocol, promptReplacement, context, input) {
  if (!Array.isArray(messages)) return null;
  // Hash the exact escaped, capped fragment inserted for ${PROMPT}.
  const promptHash = createHash('md5').update(promptReplacement ?? classificationPromptReplacement(messages, role.classification_max_token)).digest('hex');
  const scope = createHash('sha256').update(JSON.stringify([
    role.role_id, role.role_updated_at, role.classification_handler_id,
    role.classification_config_hash, role.evaluation_script ?? DEFAULT_EVALUATION_SCRIPT,
    // Evaluation may derive context from fields outside the reduced prompt.
    ...(role.input_script != null || role.output_script != null ? [role.input_script, role.output_script, createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex')] : []),
    ...(protocol ? [protocol] : []),
    ...(role.prompt_script != null ? [role.prompt_script, context] : []),
  ])).digest('hex');
  return `infergate:classification:v5:${scope}:${promptHash}`;
}

export function validCachedClassification(value) {
  return (value?.context === undefined || (value.context !== null && typeof value.context === 'object' && !Array.isArray(value.context))) && value?.version === 1 && typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 255 &&
    typeof value.category === 'string' && [...value.category].length <= 255 && typeof value.sensitiveData === 'boolean' &&
    (value.complexity == null || (Number.isInteger(value.complexity) && value.complexity >= 0 && value.complexity <= 2));
}

export function createClassificationCache(settings, options = {}) {
  return createJsonCache(settings, { validate: validCachedClassification, maxBytes: 8192,
    event: 'classification_cache_unavailable', ...options });
}
