import { fail } from '../errors.js';
import { gzipSync, zstdCompressSync } from 'node:zlib';
export function accountingBody(req, body) {
  if (req.method !== 'POST' || !/^\/chat\/completions\/?$/.test(req.url.split('?')[0]) || !(req.get('content-type') || '').includes('application/json')) return body;
  const input = JSON.parse(body.toString('utf8'));
  if (input.stream !== true) return body;
  // Usage belongs to gateway accounting, even when the caller did not request it.
  // Leave malformed options to upstream validation rather than silently repairing them.
  if (input.stream_options !== undefined && (!input.stream_options || typeof input.stream_options !== 'object' || Array.isArray(input.stream_options))) return body;
  return Buffer.from(JSON.stringify({ ...input, stream_options: { ...input.stream_options, include_usage: true } }));
}
export function upstreamUrl(base, suffix) {
  const path = suffix.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { fail(400, 'invalid_path', 'Invalid request path'); }
  if (!path.startsWith('/') || decoded.includes('\\') || decoded.split('/').some(part => part === '.' || part === '..') || /%2f|%5c|%25/i.test(path)) fail(400, 'invalid_path', 'Invalid request path');
  const url = new URL(base.replace(/\/$/, '') + suffix);
  if (url.origin !== new URL(base).origin) fail(400, 'invalid_path', 'Invalid request path');
  return url;
}
export function requestHeaders(req, credential) {
  const headers = new Headers({ authorization: `Bearer ${credential}`, 'accept-encoding': 'identity' });
  const blocked = new Set((req.get('connection') || '').toLowerCase().split(',').map(s => s.trim()));
  for (const name of ['content-type', 'accept', 'openai-beta']) if (!blocked.has(name) && req.get(name)) headers.set(name, req.get(name));
  return headers;
}
export function compressBody(body, compression) {
  if (body === undefined || compression === 'NONE' || !compression) return body;
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (compression === 'GZIP') return gzipSync(bytes);
  if (compression === 'ZSTD') return zstdCompressSync(bytes);
  fail(500, 'invalid_compression', 'Unsupported provider request compression');
}
export function providerCompression(assignment, endpoint) {
  if (endpoint === 'responses') return assignment.request_compression_r || 'NONE';
  if (endpoint === 'messages') return assignment.request_compression_m || 'NONE';
  return assignment.request_compression_c || 'NONE';
}
export function responseHeaders(upstream, res) {
  const blocked = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','content-encoding','set-cookie','access-control-allow-origin','access-control-allow-credentials']);
  for (const name of (upstream.headers.get('connection') || '').split(',')) blocked.add(name.trim().toLowerCase());
  for (const [name, value] of upstream.headers) if (!blocked.has(name) && (['content-type','cache-control','retry-after','x-request-id','www-authenticate'].includes(name) || name.startsWith('x-ratelimit-') || (res.locals?.anthropicProtocol && (['request-id','x-should-retry'].includes(name) || name.startsWith('anthropic-ratelimit-'))))) res.setHeader(name, value);
}
