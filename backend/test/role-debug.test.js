import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { Database } from '../src/db/pool.js';
import { rolesRouter } from '../src/routes/roles.js';

const schema = await readFile(new URL('../src/db/sqlite-schema.sql', import.meta.url), 'utf8');
const migrate = new URL('../src/db/migrate.js', import.meta.url);

test('SQLite upgrades existing roles with debug disabled and migration is repeatable', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'infergate-role-debug-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const existing of [false, true]) {
    const path = join(dir, `${existing}.sqlite`);
    if (existing) {
      const previous = schema.replace('  debug_enabled INTEGER NOT NULL DEFAULT 0 CHECK (debug_enabled IN (0,1)),\n', '');
      const db = new DatabaseSync(path);
      db.exec(previous);
      db.prepare('INSERT INTO schema_migrations(name,checksum) VALUES (?,?)').run('sqlite-schema.sql', createHash('sha256').update(previous).digest('hex'));
      db.exec("INSERT INTO roles(name) VALUES ('Existing role')");
      db.close();
    }
    for (let i = 0; i < 2; i++) execFileSync(process.execPath, [migrate.pathname], { env: { ...process.env, DB_ENABLED: 'false', SQLITE_DB_PATH: path } });
    const db = new DatabaseSync(path);
    if (!existing) db.exec("INSERT INTO roles(name) VALUES ('New role')");
    assert.equal(db.prepare('SELECT debug_enabled FROM roles').get().debug_enabled, 0);
    db.close();
  }
});

test('role API persists strict debug booleans and preserves omitted updates', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'infergate-role-api-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pathToDb = join(dir, 'test.sqlite');
  const raw = new DatabaseSync(pathToDb);
  raw.exec(schema);
  raw.close();
  const db = new Database({ engine: 'sqlite', path: pathToDb });
  await db.query("INSERT INTO model_policies(name) VALUES ('Policy')");
  const app = express();
  app.use(express.json(), rolesRouter(db));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); });
  const call = (path, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const body = { name: 'Role', model_policy_ids: [1] };
  const created = await call('/roles', 'POST', body);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const path = `/roles/${id}`;
  assert.equal((await (await call(path)).json()).debug_enabled, false);
  for (const invalid of [null, 1, 'true', {}]) assert.equal((await call(path, 'PUT', { ...body, debug_enabled: invalid })).status, 400);
  for (const value of [true, false]) {
    assert.equal((await call(path, 'PUT', { ...body, debug_enabled: value })).status, 204);
    assert.equal((await call(path, 'PUT', body)).status, 204);
    assert.equal((await (await call(path)).json()).debug_enabled, value);
    assert.equal((await (await call('/roles')).json()).data[0].debug_enabled, value);
  }
});
