import { runRoleScript, updateScriptContext } from './role-script-runner.js';
import { fail } from '../errors.js';

export async function updateResponseOutput(script, output, outputType, context, { signal, helpers, scriptTimeouts } = {}) {
  const result = await runRoleScript({ mode: 'output', script, input: output, inputType: outputType, context }, { signal, kind: 'output_script', helpers, scriptTimeouts });
  if (!result?.value || typeof result.value !== 'object' || Array.isArray(result.value))
    fail(502, 'invalid_output_script_result', 'Output script must resolve to a JSON object');
  updateScriptContext(context, result.context, 'output_script');
  return Buffer.from(JSON.stringify(result.value));
}
