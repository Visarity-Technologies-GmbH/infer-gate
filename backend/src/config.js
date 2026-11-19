import { fileURLToPath } from 'node:url';

export function config(env = process.env) {
  const integer = (key, fallback) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
    return value;
  };
  const timeout = (key, fallback) => {
    const value = integer(key, fallback);
    if (value > 2147483647) throw new Error(`Invalid ${key}`);
    return value;
  };
  const encryptionKey = Buffer.from(env.ENCRYPTION_KEY || '', 'base64');
  if (encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY must encode 32 random bytes');
  if (!env.BOOTSTRAP_TOKEN || env.BOOTSTRAP_TOKEN.length < 32) throw new Error('BOOTSTRAP_TOKEN must contain at least 32 characters');
  if (!['ALLOW', 'DENY'].includes(env.MODEL_DEFAULT || 'DENY')) throw new Error('Invalid MODEL_DEFAULT');
  const boolean = (key, fallback) => {
    if (env[key] === undefined) return fallback;
    if (!['true', 'false'].includes(env[key])) throw new Error(`Invalid ${key}`);
    return env[key] === 'true';
  };
  const mysqlEnabled = boolean('DB_ENABLED', true);
  const sqlitePath = env.SQLITE_DB_PATH || fileURLToPath(new URL('../data/infergate.sqlite', import.meta.url));
  const redisDatabase = Number(env.REDIS_DB ?? 0);
  if (!Number.isSafeInteger(redisDatabase) || redisDatabase < 0) throw new Error('Invalid REDIS_DB');
  const redisPort = integer('REDIS_PORT', 6379);
  if (redisPort > 65535) throw new Error('Invalid REDIS_PORT');
  return { host: env.HOST || '127.0.0.1', port: integer('PORT', 3000), encryptionKey,
    mcpAllowedOrigin: env.MCP_ALLOWED_ORIGIN || undefined,
    bootstrapToken: env.BOOTSTRAP_TOKEN, modelDefault: env.MODEL_DEFAULT || 'DENY',
    timeout: integer('UPSTREAM_TIMEOUT_MS', 300000), bodyLimit: integer('BODY_LIMIT_BYTES', 10485760),
    scriptTimeouts: { fetchMs: timeout('SCRIPT_FETCH_TIMEOUT_MS', 60000), totalMs: timeout('SCRIPT_TOTAL_TIMEOUT_MS', 300000) },
    modelCatalogueCacheTtlSeconds: integer('MODEL_CATALOGUE_CACHE_TTL_SECONDS', 300),
    stringCacheTtlSeconds: integer('STRING_CACHE_TTL_SECONDS', 3600),
    stringCacheMaxLength: integer('STRING_CACHE_MAX_LENGTH', 32768),
    redis: { enabled: boolean('REDIS_ENABLED', true), host: env.REDIS_HOST || '127.0.0.1', port: redisPort,
      username: env.REDIS_USERNAME || '', password: env.REDIS_PASSWORD || '', database: redisDatabase,
      tls: boolean('REDIS_TLS', false), timeoutMs: integer('REDIS_TIMEOUT_MS', 100), ttlSeconds: integer('CLASSIFICATION_CACHE_TTL_SECONDS', 3600) },
    stringCache: { enabled: boolean('REDIS_ENABLED', true), host: env.REDIS_HOST || '127.0.0.1', port: redisPort,
      username: env.REDIS_USERNAME || '', password: env.REDIS_PASSWORD || '', database: redisDatabase,
      tls: boolean('REDIS_TLS', false), timeoutMs: integer('REDIS_TIMEOUT_MS', 100),
      ttlSeconds: integer('STRING_CACHE_TTL_SECONDS', 3600), maxLength: integer('STRING_CACHE_MAX_LENGTH', 32768) },
    db: mysqlEnabled
      ? { engine: 'mysql', socketPath: env.DB_SOCKET || undefined, host: env.DB_HOST || '127.0.0.1', port: integer('DB_PORT', 3307), user: env.DB_USER || 'infergate',
        password: env.DB_PASSWORD, database: env.DB_NAME || 'InferGate', timezone: 'Z', charset: 'utf8mb4', connectionLimit: 10, supportBigNumbers: true, bigNumberStrings: true }
      : { engine: 'sqlite', path: sqlitePath } };
}
