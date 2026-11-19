import { fail } from '../errors.js';
import { updateResponseOutput } from './output-script.js';

// Buffer only one SSE event; retain event/id/retry/comment fields and the
// protocol's non-JSON completion marker. Normalize SSE line endings to LF.
export async function* transformOutputStream(body, script, outputType, context, { signal, helpers, scriptTimeouts, onOriginal = async () => {}, onUpdated = async () => {} } = {}) {
  if (!body) fail(502, 'incomplete_stream', 'Provider returned no stream');
  const decoder = new TextDecoder();
  let buffer = '', pendingCR = false;
  const limit = 1024 * 1024;
  let tail = [], tailBytes = 0;
  async function transform(frame) {
    const lines = frame.split('\n');
    const data = lines.filter(line => line === 'data' || line.startsWith('data:'))
      .map(line => line === 'data' ? '' : line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data.trim() === '[DONE]') {
      const chunk = Buffer.from(frame + '\n\n');
      chunk.infergateTerminal = outputType === 'OPENAI' && data.trim() === '[DONE]';
      return chunk;
    }
    let output;
    try { output = JSON.parse(data); }
    catch { fail(502, 'invalid_output_script_input', 'Output script requires JSON stream events'); }
    if (!output || typeof output !== 'object' || Array.isArray(output))
      fail(502, 'invalid_output_script_input', 'Output script requires JSON stream objects');
    await onOriginal(output);
    const updated = await updateResponseOutput(script, output, outputType, context, { signal, helpers, scriptTimeouts });
    await onUpdated(JSON.parse(updated.toString('utf8')));
    let inserted = false;
    const result = [];
    for (const line of lines) {
      if (line === 'data' || line.startsWith('data:')) {
        if (!inserted) result.push('data: ' + updated.toString('utf8'));
        inserted = true;
      } else result.push(line);
    }
    const chunk = Buffer.from(result.join('\n') + '\n\n');
    chunk.infergateFinish = outputType === 'OPENAI' && output.choices?.some(choice => choice.finish_reason != null);
    chunk.infergateTerminal = (outputType === 'ANTHROPIC' && output.type === 'message_stop') ||
      (outputType === 'OPENAI_RESPONSES' && ['response.completed', 'response.failed', 'response.incomplete'].includes(output.type));
    return chunk;
  }
  async function prepare(frame) {
    const chunk = await transform(frame);
    // Clients may close as soon as they see finish_reason. Complete scripts on
    // the bounded usage/DONE tail before exposing that signal to the client.
    if (tail.length || chunk.infergateFinish) {
      tailBytes += chunk.length;
      if (tailBytes > limit) fail(502, 'invalid_output_script_input', 'Stream completion tail exceeds the supported limit');
      tail.push(chunk);
      if (!chunk.infergateTerminal) return null;
      const complete = Buffer.concat(tail);
      complete.infergateTerminal = true;
      tail = []; tailBytes = 0;
      return complete;
    }
    return chunk;
  }
  for await (const chunk of body) {
    signal?.throwIfAborted();
    let text = (pendingCR ? '\r' : '') + decoder.decode(chunk, { stream: true });
    pendingCR = text.endsWith('\r');
    if (pendingCR) text = text.slice(0, -1);
    buffer += text.replace(/\r\n|\r/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (Buffer.byteLength(frame) > limit) fail(502, 'invalid_output_script_input', 'Stream event exceeds the output script input limit');
      const prepared = await prepare(frame);
      if (prepared) {
        yield prepared;
        if (prepared.infergateTerminal) return;
      }
    }
    if (Buffer.byteLength(buffer) > limit) fail(502, 'invalid_output_script_input', 'Stream event exceeds the output script input limit');
  }
  buffer += decoder.decode() + (pendingCR ? '\n' : '');
  // A final CR can complete the last event.
  while (buffer.includes('\n\n')) {
    const boundary = buffer.indexOf('\n\n');
    const prepared = await prepare(buffer.slice(0, boundary));
    if (prepared) {
      yield prepared;
      if (prepared.infergateTerminal) return;
    }
    buffer = buffer.slice(boundary + 2);
  }
  if (tail.length || buffer.trim()) fail(502, 'incomplete_stream', 'Provider stream ended during an event');
}
