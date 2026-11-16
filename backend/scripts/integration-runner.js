import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
const database = `infergate_test_${randomBytes(8).toString('hex')}`;
const connection = await mysql.createConnection({ socketPath: process.env.DB_SOCKET || undefined, host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307), user: process.env.DB_USER || 'infergate', password: process.env.DB_PASSWORD });
const run = args => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: new URL('../', import.meta.url), stdio: 'inherit', env: { ...process.env, DB_NAME: database, TEST_DB_NAME: database } });
  child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Test process exited with ${code}`)));
});
let created = false;
try {
  await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); created = true;
  await run(['src/db/migrate.js']);
  await run(['src/db/migrate.js']); // Applied migration checksums and repeat execution.
  await run(['--test']);
} finally {
  if (created) await connection.query(`DROP DATABASE \`${database}\``);
  await connection.end();
}
