import { Script } from 'node:vm';
import { fail } from '../errors.js';

export const DEFAULT_EVALUATION_SCRIPT = `/**
Input:
  * input - Original input of /v1/messages, /v1/chat/completions or /v1/responses
  * input_type - "ANTHROPIC", "OPENAI", or "OPENAI_RESPONSES"
  * classification - Output of the classification API call
  * models - Array of available models (just the IDs of the models)
  * context - Request-local object shared with prompt, updateInput and updateOutput

Output:
  * Promise resolving to a json object {
    category: "",         //String
    sensitiveData: true,  //Boolean true or false
    complexity: 0, //0-easy, 1-medium, 2-hard (better handled by a foundation model)
    models: ["qwen/qwen3.5-9b", ".."]           //String array of Model IDs or null
  }
*/

async function evaluate(input, input_type, classification, models, context) {
//Code here
  return { category: "other", sensitiveData: false, complexity: 0, models: null }
}
`;

export function validateEvaluationScript(value) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 32768)
    fail(400, 'invalid_evaluation_script', 'Evaluation script must be nonempty JavaScript (at most 32768 characters)');
  // Compile only. Saving a script must never execute administrator-supplied code.
  try { new Script(value); }
  catch { fail(400, 'invalid_evaluation_script', 'Evaluation script contains invalid JavaScript syntax'); }
  return value;
}

export function roleWithEvaluationScript(role) {
  return { ...role, evaluation_script: role.evaluation_script ?? (role.classification_handler_id != null ? DEFAULT_EVALUATION_SCRIPT : null) };
}
