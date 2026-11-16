import { createClient } from '@redis/client';

const KEY_PREFIX = 'string:v1:';

export function createStringCache(settings, { clientFactory = createClient } = {}) {
  if (!settings?.enabled) settings = { ...settings, enabled: false };
  let client, connecting, closed = false, retryAfter = 0;

  async function ready() {
    if (!settings.enabled || closed || Date.now() < retryAfter) return null;
    if (client?.isReady) return client;
    if (connecting) return connecting;
    client = clientFactory({
      socket: { host: settings.host, port: settings.port, tls: settings.tls, connectTimeout: settings.timeoutMs, reconnectStrategy: false },
      username: settings.username || undefined, password: settings.password || undefined,
      database: settings.database, disableOfflineQueue: true,
    });
    client.on('error', () => {});
    const current = client;
    connecting = current.connect().then(() => current).finally(() => { connecting = null; });
    return connecting;
  }

  async function boundedReady() {
    let timer;
    try {
      return await Promise.race([ready(), new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          if (client?.isOpen) client.destroy();
          reject(new Error('Cache connection timeout'));
        }, settings.timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  function failed() { retryAfter = Date.now() + 5000; }

  return {
    async readStringCache(key) {
      if (typeof key !== 'string' || !key) return null;
      try {
        const connection = await boundedReady();
        if (!connection) return null;
        const value = await connection.withCommandOptions({ timeout: settings.timeoutMs }).get(KEY_PREFIX + key);
        return typeof value === 'string' && value.length <= settings.maxLength ? value : null;
      } catch { failed(); return null; }
    },
    async writeStringCache(key, value) {
      if (typeof key !== 'string' || !key || typeof value !== 'string' || value.length > settings.maxLength) return false;
      try {
        const connection = await boundedReady();
        if (!connection) return false;
        await connection.withCommandOptions({ timeout: settings.timeoutMs }).set(KEY_PREFIX + key, value, { EX: settings.ttlSeconds });
        return true;
      } catch { failed(); return false; }
    },
    close() { closed = true; if (client?.isOpen) client.destroy(); },
  };
}
