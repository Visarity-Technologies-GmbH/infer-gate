import { gzipSync, zstdCompressSync } from 'node:zlib';
import { resolveUpstreamCredential } from '../security/upstream-credential.js';
import { bedrockBaseUrl, bedrockMessagesBaseUrl } from '../providers/bedrock.js';

const plainBody = Buffer.from('{}');
const bodies = { GZIP: gzipSync(plainBody), ZSTD: zstdCompressSync(plainBody) };
const decodeFailure = /(?:parse|decode|decompress|encoding).{0,100}(?:body|json|gzip|zstd|utf-?8)|(?:body|json|gzip|zstd|utf-?8).{0,100}(?:parse|decode|decompress|encoding)|unsupported content.encoding|invalid (?:utf-?8|compressed)|expected value at line 1 column 1/i;
const schemaValidation = /missing (?:required )?(?:field|parameter)|(?:field|parameter).{0,40}required|required.{0,40}(?:field|parameter)|validation error|at least one.{0,50}(?:required|must)|must not be empty|must be (?:a |an )?(?:string|array|object|integer)|expected.{0,40}(?:field|object|array|string)|invalid model|model.{0,40}required|messages.{0,40}required|input.{0,40}required|max_tokens.{0,40}required/i;

function errorSignature(body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return body.replace(/request[_ -]?id[":= ]+[\w-]+/gi, '').replace(/\s+/g, ' ').trim(); }
  const messages = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.message === 'string') messages.push(value.message);
    if (typeof value.detail === 'string') messages.push(value.detail);
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  visit(parsed);
  return messages.sort().join('|').replace(/request[_ -]?id[":= ]+[\w-]+/gi, '').replace(/\s+/g, ' ').trim();
}

function endpoints(assignment) {
  if (assignment.api_type === 'AWS_BEDROCK') return [
    ['c', bedrockBaseUrl(assignment.aws_region), '/chat/completions'],
    ['r', bedrockBaseUrl(assignment.aws_region), '/responses'],
    ['m', bedrockMessagesBaseUrl(assignment.aws_region), '/messages'],
  ];
  const messagesBase = assignment.api_type === 'OPENAI_ANTHROPIC'
    ? assignment.anthropic_api_url || assignment.api_url : assignment.api_url;
  return [
    ['c', assignment.api_url, '/chat/completions'],
    ['r', assignment.api_url, '/responses'],
    ['m', messagesBase, '/messages'],
  ];
}

function requestHeaders(type, key, endpoint, compression) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (type === 'AWS_BEDROCK') headers.set('x-api-key', key);
  else if (endpoint === 'm' && ['ANTHROPIC','OPENAI_ANTHROPIC'].includes(type)) {
    headers.set('x-api-key', key);
    headers.set('anthropic-version', '2023-06-01');
  } else if (type === 'ANTHROPIC') {
    headers.set('x-api-key', key);
    headers.set('anthropic-version', '2023-06-01');
  } else headers.set('authorization', `Bearer ${key}`);
  if (compression !== 'NONE') headers.set('content-encoding', compression.toLowerCase());
  return headers;
}

async function probe({ type, key, base, path, endpoint, compression, fetchImpl, signal }) {
  const response = await fetchImpl(new URL(base.replace(/\/$/, '') + path), {
    method: 'POST', headers: requestHeaders(type, key, endpoint, compression),
    body: compression === 'NONE' ? plainBody : bodies[compression],
    redirect: 'manual', signal,
  });
  const body = (await response.text()).slice(0, 8192);
  if ([401, 403].includes(response.status)) throw new Error('Upstream credential was rejected during compression check');
  if (response.status >= 500) throw new Error('Upstream unavailable during compression check');
  const endpointExists = ![404, 405].includes(response.status);
  const accepted = endpointExists && [400, 422].includes(response.status) && !decodeFailure.test(body);
  return { status: response.status, endpointExists, accepted, schemaValidated: accepted && schemaValidation.test(body), signature: errorSignature(body) };
}

export async function checkUpstreamCompression(assignment, config, { fetchImpl = fetch, signal } = {}) {
  const key = resolveUpstreamCredential(assignment.encrypted_api_key, config.encryptionKey);
  const values = {};
  for (const [suffix, base, path] of endpoints(assignment)) {
    const results = await Promise.all(['NONE','GZIP','ZSTD'].map(compression => probe({
      type: assignment.api_type, key, base, path, endpoint: suffix, compression,
      fetchImpl, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    })));
    if (!results[0].endpointExists) values[`request_compression_${suffix}`] = 'NONE';
    else if (!results[0].accepted) throw new Error(`Uncompressed ${suffix} probe could not validate the upstream endpoint`);
    else {
      const supported = result => result.accepted && result.status === results[0].status && (
        result.schemaValidated || (results[0].signature && result.signature === results[0].signature)
      );
      values[`request_compression_${suffix}`] = supported(results[2]) ? 'ZSTD' : supported(results[1]) ? 'GZIP' : 'NONE';
    }
  }
  return values;
}
