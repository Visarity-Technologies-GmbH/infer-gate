import { readdir } from 'node:fs/promises';
import { config } from './config.js';
import { Database } from './db/pool.js';
import { createApp } from './app.js';
import { createModelCatalogue } from './services/model-catalogue.js';
import { createClassificationCache } from './services/classification-cache.js';
import { createStringCache } from './services/string-cache.js';
const settings = config(), db = new Database(settings.db);
if (db.engine === 'sqlite') {
  const [migrationTable] = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
  const [schema] = migrationTable ? await db.query("SELECT name FROM schema_migrations WHERE name='sqlite-schema.sql'") : [];
  if (!schema) { await db.close(); throw new Error('Run database migrations before starting InferGate'); }
} else {
  const required = (await readdir(new URL('./db/migrations/', import.meta.url))).filter(file => file.endsWith('.sql'));
  const migrations = new Set((await db.query('SELECT name FROM schema_migrations')).map(row => row.name));
  if (required.some(file => !migrations.has(file))) { await db.close(); throw new Error('Run database migrations before starting InferGate'); }
}
const classificationCache = createClassificationCache(settings.redis);
const stringCache = createStringCache(settings.stringCache);
const modelCatalogue = createModelCatalogue(settings);
const server = createApp(db, settings, { classificationCache, stringCache, modelCatalogue }).listen(settings.port, settings.host, () => console.log(JSON.stringify({ event: 'listening', host: settings.host, port: settings.port })));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  const timer = setTimeout(() => { server.closeAllConnections(); }, 30000); timer.unref();
  server.close(async () => { clearTimeout(timer); classificationCache?.close(); stringCache.close(); modelCatalogue.close(); await db.close(); });
});
