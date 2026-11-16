import { isDeepStrictEqual } from 'node:util';
import { fail } from '../errors.js';

// Validate the gateway-relevant shape without restricting provider-specific
// Responses item types or other upstream options.
export function validateResponsesInput(input, original) {
  const invalid = message => fail(502, 'invalid_input_script_result', message);
  if (typeof input.model !== 'string' || !input.model || input.model.length > 255)
    invalid('Updated Responses input must contain a valid model');
  if (input.stream !== undefined && typeof input.stream !== 'boolean')
    invalid('Updated Responses stream must be a boolean');
  if (input.input !== undefined && typeof input.input !== 'string' &&
      !(Array.isArray(input.input) && input.input.every(item => item && typeof item === 'object' && !Array.isArray(item))))
    invalid('Updated Responses input must be a string or an array of items');
  if (input.input === undefined && input.previous_response_id == null && input.conversation == null)
    invalid('Updated Responses request must contain input or a conversation reference');
  if (input.previous_response_id != null && (typeof input.previous_response_id !== 'string' || !input.previous_response_id))
    invalid('Updated Responses previous_response_id must be a non-empty string');
  if (input.conversation != null && !(typeof input.conversation === 'string' ? input.conversation.length > 0 :
    typeof input.conversation === 'object' && !Array.isArray(input.conversation) && typeof input.conversation.id === 'string' && input.conversation.id.length > 0))
    invalid('Updated Responses conversation must be an ID or an object containing an ID');
  if (input.previous_response_id != null && input.conversation != null)
    invalid('Updated Responses request cannot combine conversation references');
  if (original.previous_response_id != null || original.conversation != null) {
    if (input.model !== original.model ||
        !isDeepStrictEqual(input.previous_response_id ?? null, original.previous_response_id ?? null) ||
        !isDeepStrictEqual(input.conversation ?? null, original.conversation ?? null))
      invalid('Input scripts must preserve the model and conversation references for Responses continuations');
  }
}
