import { discoveryTimeout } from './discovery-cooldown.js';
import { createHash } from 'node:crypto';
import { createJsonCache } from './redis-cache.js';
import { prepareProviderRequest, executeProviderRequest } from '../providers/index.js';
import { resolveUpstreamCredential } from '../security/upstream-credential.js';
import { filterModelList } from './model-list.js';

const maxBytes = 10 * 1024 * 1024;
export function modelCatalogueCacheKey(assignment, config, url = '/models') {
  const credential = resolveUpstreamCredential(assignment.encrypted_api_key, config.encryptionKey);
  const scope = [assignment.upstream_api_key_id, assignment.provider_id, assignment.api_url,
    assignment.api_type || 'OPENAI_COMPATIBLE', assignment.aws_region ?? null, credential, url];
  return `infergate:model-catalogue:v1:${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}`;
}

export function validCatalogue(value) {
  return value?.version === 1 && Number.isInteger(value.status) && value.status >= 200 && value.status < 300 &&
    value.status !== 204 && value.status !== 205 && value.catalogue && Array.isArray(value.catalogue.data) &&
    value.catalogue.data.every(model => model && typeof model.id === 'string' && model.id.length > 0);
}

// One service per backend process. Shared fetches have their own timeout so a
// disconnected caller cannot cancel discovery for other waiting requests.
export function createModelCatalogue(config, { fetchImpl = fetch, cache, ...options } = {}) {
  const store = cache ?? createJsonCache({ ...config.redis, ttlSeconds: config.modelCatalogueCacheTtlSeconds ?? 300 },
    { validate: validCatalogue, maxBytes, event: 'model_catalogue_cache_unavailable', ...options });
  const pending = new Map();
  async function load(key, assignment, url, requestId, onFetch) {
    const cached = await store?.get(key, { requestId });
    if (cached) return cached;
    const signal = AbortSignal.timeout(discoveryTimeout(config));
    const req = { method: 'GET', url, get: () => undefined };
    const plan = prepareProviderRequest(assignment, req, undefined, config, signal);
    await onFetch?.();
    const upstream = await executeProviderRequest(plan, fetchImpl);
    // Failed responses remain unbuffered and uncached. Only one caller may
    // consume this stream; other waiters retry independently.
    if (!upstream.ok) return { upstream };
    const catalogue = await filterModelList(upstream, [], 'ALLOW');
    const value = { version: 1, status: upstream.status, catalogue };
    if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) await store?.set(key, value, { requestId });
    // Preserve fresh response headers, but do not replay request IDs or rate-limit
    // snapshots from Redis on later requests.
    const headers = new Headers(upstream.headers);
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(name);
    return { ...value, headers };
  }
  return {
    async get(assignment, { signal, requestId, url = '/models', onFetch } = {}) {
      signal?.throwIfAborted();
      const key = modelCatalogueCacheKey(assignment, config, url);
      let task = pending.get(key);
      if (!task) {
        task = load(key, assignment, url, requestId, onFetch).finally(() => pending.delete(key));
        pending.set(key, task);
      }
      let abort;
      try {
        const result = await Promise.race([task, new Promise((resolve, reject) => {
          abort = () => reject(signal.reason);
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        })]);
        if (result.upstream) {
          if (result.claimed) return this.get(assignment, { signal, requestId, url, onFetch });
          result.claimed = true;
          return result.upstream;
        }
        return Response.json(result.catalogue, { status: result.status, headers: result.headers });
      } finally { signal?.removeEventListener('abort', abort); }
    },
    close() { store?.close(); },
  };
}
