import { DEFAULT_EVALUATION_SCRIPT } from './evaluation-script.js';
import { runRoleScript, updateScriptContext } from './role-script-runner.js';
import { fail } from '../errors.js';

export function validateEvaluationResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      typeof result.category !== 'string' || [...result.category].length > 255 ||
      typeof result.sensitiveData !== 'boolean' ||
      (result.complexity != null && (!Number.isInteger(result.complexity) || result.complexity < 0 || result.complexity > 2)) ||
      (result.models !== null && (!Array.isArray(result.models) || result.models.length > 1000 ||
        result.models.some(model => typeof model !== 'string' || !model || model.length > 255)))) {
    fail(502, 'invalid_evaluation_result', 'Evaluation must return category (string), sensitiveData (boolean), complexity (integer 0–2 or null), and models (string array or null)');
  }
  return { category: result.category, sensitiveData: result.sensitiveData, complexity: result.complexity ?? null, models: result.models };
}

export async function evaluateClassification(script, input, classification, models, { signal, inputType = 'OPENAI', context = {}, helpers, scriptTimeouts } = {}) {
  const result = await runRoleScript({ mode: 'evaluation', script: script ?? DEFAULT_EVALUATION_SCRIPT, input, inputType, classification, models, context }, { signal, helpers, scriptTimeouts });
  const evaluation = validateEvaluationResult(result?.value);
  updateScriptContext(context, result.context, 'evaluation');
  return evaluation;
}
