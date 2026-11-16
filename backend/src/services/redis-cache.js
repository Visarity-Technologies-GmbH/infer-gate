import { createClient } from '@redis/client';

export function createJsonCache(settings, { validate, maxBytes, event, clientFactory = createClient, log = value => console.log(JSON.stringify(value)) } = {}) {
  if (!settings?.enabled) return null;
  let client, connecting, closed = false, retryAfter = 0;
  async function ready() {
    if (closed || Date.now() < retryAfter) return null;
    if (client?.isReady) return client;
    if (connecting) return connecting;
    client = clientFactory({
      socket: { host: settings.host, port: settings.port, tls: settings.tls, connectTimeout: settings.timeoutMs, reconnectStrategy: false },
      username: settings.username || undefined, password: settings.password || undefined,
      database: settings.database, disableOfflineQueue: true,
    });
    client.on('error', () => {}); // Never log Redis errors containing connection details.
    const current = client;
    connecting = current.connect().then(() => current).finally(() => { connecting = null; });
    return connecting;
  }
  function failed(requestId) {
    retryAfter = Date.now() + 5000;
    log({ event, request_id: requestId });
  }
  async function boundedReady(signal) {
    let timer, abort;
    try {
      return await Promise.race([ready(), new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          if (client?.isOpen) client.destroy();
          reject(new Error('Cache connection timeout'));
        }, settings.timeoutMs);
        abort = () => reject(new Error('Cache connection aborted'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  return {
    async get(key, { signal, requestId } = {}) {
      if (!key || signal?.aborted) return null;
      try {
        const connection = await boundedReady(signal);
        if (!connection || signal?.aborted) return null;
        const raw = await connection.withCommandOptions({ timeout: settings.timeoutMs, abortSignal: signal }).get(key);
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > maxBytes) return null;
        let value;
        try { value = JSON.parse(raw); } catch { return null; }
        return validate(value) ? value : null;
      } catch { failed(requestId); return null; }
    },
    async set(key, value, { signal, requestId } = {}) {
      if (!key || !validate(value) || signal?.aborted) return;
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) > maxBytes) return;
      try {
        const connection = await boundedReady(signal);
        if (!connection || signal?.aborted) return;
        await connection.withCommandOptions({ timeout: settings.timeoutMs, abortSignal: signal }).set(key, encoded, { EX: settings.ttlSeconds });
      } catch { failed(requestId); }
    },
    close() { closed = true; if (client?.isOpen) client.destroy(); },
  };
}
