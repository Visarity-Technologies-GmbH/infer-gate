import { runRoleScript, updateScriptContext } from './role-script-runner.js';
import { fail } from '../errors.js';

export async function updateRequestInput(script, input, inputType, context, { signal, bodyLimit, helpers } = {}) {
  const result = await runRoleScript({ mode: 'input', script, input, inputType, context }, { signal, kind: 'input_script', helpers });
  if (!result?.value || typeof result.value !== 'object' || Array.isArray(result.value))
    fail(502, 'invalid_input_script_result', 'Input script must resolve to a JSON object');
  const body = Buffer.from(JSON.stringify(result.value));
  if (body.length > bodyLimit)
    fail(502, 'invalid_input_script_result', 'Updated input exceeds the request body limit');
  updateScriptContext(context, result.context, 'input_script');
  return { input: result.value, body };
}
