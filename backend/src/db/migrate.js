import mysql from 'mysql2/promise';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

async function migrateSqlite() {
  const configured = process.env.DB_ENABLED ?? 'true';
  if (!['true', 'false'].includes(configured)) throw new Error('DB_ENABLED must be true or false');
  if (configured !== 'false') return false;

  const path = process.env.SQLITE_DB_PATH || fileURLToPath(new URL('../../data/infergate.sqlite', import.meta.url));
  const absolutePath = path === ':memory:' ? path : resolve(path);
  const schemaUrl = new URL('./sqlite-schema.sql', import.meta.url);
  const schema = await readFile(schemaUrl, 'utf8');
  const checksum = createHash('sha256').update(schema).digest('hex');
  const database = new DatabaseSync(absolutePath, { enableForeignKeyConstraints: true, timeout: 5000 });
  try {
    database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    const hasHistory = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const previous = hasHistory ? database.prepare('SELECT checksum FROM schema_migrations WHERE name=?').get('sqlite-schema.sql') : null;
    if (previous && previous.checksum !== checksum) {
      throw new Error('SQLite schema changed after it was applied; add a versioned SQLite migration before upgrading this database');
    }
    database.exec(schema);
    if (!previous) database.prepare('INSERT INTO schema_migrations(name,checksum) VALUES (?,?)').run('sqlite-schema.sql', checksum);
    console.log(`SQLite database ready at ${absolutePath}`);
  } finally {
    database.close();
  }
  return true;
}

if (await migrateSqlite()) process.exit(0);

async function migrate() {
const name = process.env.DB_NAME || 'InferGate';
if (!/^[a-zA-Z0-9_]+$/.test(name)) throw new Error('Invalid database name');
const connection = await mysql.createConnection({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD, multipleStatements: true });
try {
  const [[lock]] = await connection.query("SELECT GET_LOCK('infergate_migrations', 10) AS acquired");
  if (!lock.acquired) throw new Error('Migration lock unavailable');
  const directory = new URL('./migrations/', import.meta.url);
  const files = (await readdir(directory)).filter(f => f.endsWith('.sql')).sort();
  const sources = new Map(await Promise.all(files.map(async file => [file, await readFile(new URL(file, directory), 'utf8')])));
  const [[history]] = await connection.execute("SELECT COUNT(*) AS present FROM information_schema.tables WHERE table_schema=? AND table_name='schema_migrations'", [name]);
  const [applied] = history.present ? await connection.query(`SELECT name,checksum FROM \`${name}\`.schema_migrations`) : [[]];
  const appliedByName = new Map(applied.map(row => [row.name, row.checksum]));
  if (applied.length && !appliedByName.has('001_public_release_baseline.sql')) {
    throw new Error('This database has pre-release migration history; the public-release baseline requires a fresh database');
  }
  const createsTriggers = files.some(file => !appliedByName.has(file) && /\bCREATE\s+TRIGGER\b/i.test(sources.get(file)));
  const [[settings]] = await connection.query('SELECT @@GLOBAL.log_bin AS binlog, @@GLOBAL.log_bin_trust_function_creators AS trusted');
  if (createsTriggers && settings.binlog && !settings.trusted) {
    const [grants] = await connection.query('SHOW GRANTS');
    const elevated = grants.some(row => /\bSUPER\b|GRANT ALL PRIVILEGES ON \*\.\*/.test(Object.values(row).join(' ')));
    if (!elevated) throw new Error('Immutable accounting triggers require a database administrator for migrations when binary logging is enabled and log_bin_trust_function_creators is OFF. No schema changes were made.');
  }
  await connection.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await connection.query(`USE \`${name}\``);
  await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)))');
  for (const file of files) {
    const sql = sources.get(file);
    const checksum = createHash('sha256').update(sql).digest('hex');
    const [[previous]] = await connection.execute('SELECT checksum FROM schema_migrations WHERE name=?', [file]);
    if (previous) { if (previous.checksum !== checksum) throw new Error(`Applied migration changed: ${file}`); continue; }
    await connection.query(sql);
    await connection.execute('INSERT INTO schema_migrations(name,checksum) VALUES (?,?)', [file, checksum]);
    console.log(`Applied ${file}`);
  }
} finally { await connection.end(); }
}
await migrate().catch(error => { console.error(JSON.stringify({ event: "migration_failed", code: error.code || "migration_requirement", message: error.code ? "Database migration failed; check database permissions and connectivity before retrying." : error.message })); process.exitCode = 1; });
