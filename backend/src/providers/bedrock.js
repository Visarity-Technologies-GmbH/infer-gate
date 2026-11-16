import { fail } from '../errors.js';
import { sseEvents, streamResponse } from './native-common.js';

// Mantle may close after its final usage event without an OpenAI DONE frame.
// Require all requested choices to finish and a subsequent usage-only event;
// transport errors and partial SSE frames must never be repaired as success.
export function bedrockChatResponse(upstream, choices = 1) {
  if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/event-stream')) return upstream;
  async function* events() {
    const finished = new Set();
    let finalUsage = false, failed = false;
    for await (const event of sseEvents(upstream.body, { allowDone: true, allowUnterminatedDone: true })) {
      if (event === '[DONE]') { yield event; return; }
      if (!event || typeof event !== 'object' || event.error || event.type === 'error') failed = true;
      const entries = event?.choices;
      finalUsage = false;
      if (Array.isArray(entries)) {
        for (const choice of entries) {
          if (!Number.isSafeInteger(choice.index) || choice.index < 0 || choice.index >= choices) { failed = true; continue; }
          if (finished.has(choice.index)) failed = true;
          if (typeof choice.finish_reason === 'string' && choice.finish_reason) finished.add(choice.index);
        }
        finalUsage = entries.length === 0 && finished.size === choices &&
          ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => Number.isSafeInteger(event.usage?.[key]) && event.usage[key] >= 0);
      }
      yield event;
    }
    if (failed || !finalUsage) fail(502, 'incomplete_stream', 'Bedrock stream ended before completion');
    yield '[DONE]';
  }
  return streamResponse(upstream, events());
}

export const BEDROCK_API_URL = 'https://bedrock-mantle.{region}.api.aws/v1';
// Commercial regions supporting the Mantle endpoint, verified against AWS's
// endpoints-region-availability documentation. One source for API validation/UI.
export const BEDROCK_REGIONS = Object.freeze([
  { id: 'us-east-1', name: 'US East (N. Virginia)' },
  { id: 'us-east-2', name: 'US East (Ohio)' },
  { id: 'us-west-2', name: 'US West (Oregon)' },
  { id: 'eu-central-1', name: 'Europe (Frankfurt)' },
  { id: 'eu-north-1', name: 'Europe (Stockholm)' },
  { id: 'eu-south-1', name: 'Europe (Milan)' },
  { id: 'eu-west-1', name: 'Europe (Ireland)' },
  { id: 'eu-west-2', name: 'Europe (London)' },
  { id: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' },
  { id: 'ap-south-1', name: 'Asia Pacific (Mumbai)' },
  { id: 'ap-southeast-2', name: 'Asia Pacific (Sydney)' },
  { id: 'ap-southeast-3', name: 'Asia Pacific (Jakarta)' },
  { id: 'sa-east-1', name: 'South America (São Paulo)' }
]);
export function validateRegion(region) {
  if (!BEDROCK_REGIONS.some(entry => entry.id === region)) fail(400, 'invalid_aws_region', 'Select a supported AWS Bedrock region');
  return region;
}
export function bedrockBaseUrl(region) {
  return BEDROCK_API_URL.replace('{region}', validateRegion(region));
}

export function bedrockMessagesBaseUrl(region) {
  return `${new URL(bedrockBaseUrl(region)).origin}/anthropic/v1`;
}

export const bedrockAnthropicModel = model => typeof model === 'string' && model.startsWith('anthropic.');
