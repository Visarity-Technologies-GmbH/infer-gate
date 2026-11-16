// Resolve only context supplied in this request. Provider-owned conversation
// references must retain their original model and bypass classification/cache.
export function responsesClassifierMessages(input) {
  if (input.previous_response_id != null || input.conversation != null) return undefined;
  if (typeof input.input !== 'string' && !Array.isArray(input.input)) return undefined;
  const messages = [];
  if (typeof input.instructions === 'string') messages.push({ role: 'system', content: input.instructions });
  if (typeof input.input === 'string') messages.push({ role: 'user', content: input.input });
  else for (const item of input.input) {
    if (item && (item.type === undefined || item.type === 'message') &&
        ['system', 'developer', 'user', 'assistant'].includes(item.role) &&
        (typeof item.content === 'string' || Array.isArray(item.content))) {
      messages.push({ role: item.role, content: item.content });
    }
  }
  return messages;
}
