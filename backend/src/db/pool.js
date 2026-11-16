import mysql from 'mysql2/promise';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function dateValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString().replace('T', ' ').replace('Z', '');
  return value;
}

function decimalUnits(value) {
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new TypeError(`Invalid decimal value: ${text}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const units = BigInt(whole) * 10n ** 12n + BigInt(fraction.padEnd(12, '0').slice(0, 12));
  return negative ? -units : units;
}

function unitsDecimal(units) {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  const whole = absolute / 10n ** 12n;
  const fraction = (absolute % 10n ** 12n).toString().padStart(12, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function normalizeSqliteRows(rows) {
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value === 'bigint') value = value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
    if (typeof value === 'string' && ['model_policy_ids', 'system_prompt_compaction'].includes(key)) {
      try { value = JSON.parse(value); } catch { /* Preserve malformed historical data for the caller to handle. */ }
    }
    return [key, value];
  })));
}

function sqliteSql(sql) {
  return sql
    .replace(/`groups`|\bgroups\b/gi, '"groups"')
    .replace(/\bDATE_ADD\(UTC_TIMESTAMP\(3\),\s*INTERVAL\s+(\d+)\s+(HOUR|DAY|MINUTE)\)/gi, (_, amount, unit) => `datetime(UTC_TIMESTAMP(), '+${amount} ${unit.toLowerCase()}')`)
    .replace(/\bDATE_SUB\(UTC_TIMESTAMP\(3\),\s*INTERVAL\s+(\d+)\s+(HOUR|DAY|MINUTE)\)/gi, (_, amount, unit) => `datetime(UTC_TIMESTAMP(), '-${amount} ${unit.toLowerCase()}')`)
    .replace(/\bUTC_TIMESTAMP\(3\)/gi, 'UTC_TIMESTAMP()')
    .replace(/\bDATE_FORMAT\(([^,]+),\s*'([^']+)'\)/gi, (_, expression, format) => `strftime('${format}', ${expression})`)
    .replace(/\bYEARWEEK\(([^,]+),\s*3\)/gi, 'ISO_YEARWEEK($1)')
    .replace(/\bJSON_ARRAYAGG\(/gi, 'json_group_array(')
    .replace(/\bCAST\(([^()]*(?:\([^()]*\)[^()]*)?)\s+AS\s+CHAR\)/gi, 'CAST($1 AS TEXT)')
    .replace(/\s+FOR\s+UPDATE\b/gi, '')
    .replace(/\bINSERT\s+IGNORE\b/gi, 'INSERT OR IGNORE')
    .replace(/\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/gi, 'ON CONFLICT DO UPDATE SET')
    .replace(/\bVALUES\((\w+)\)/gi, 'excluded.$1')
    .replace(/\bSHA2\(/gi, 'SHA2(')
    .replace(/\bSUM\(/gi, /usage_costs/i.test(sql) ? 'DECIMAL_SUM(' : 'SUM(');
}

function createSqlite(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  database.function('UTC_TIMESTAMP', () => new Date().toISOString().replace('T', ' ').replace('Z', ''));
  database.function('SHA2', (value, bits) => Number(bits) === 256 ? createHash('sha256').update(String(value)).digest('hex') : null);
  database.function('ISO_YEARWEEK', value => {
    if (value == null) return null;
    const date = new Date(`${String(value).replace(' ', 'T')}Z`);
    if (!Number.isFinite(date.getTime())) return null;
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
    const year = day.getUTCFullYear();
    const yearStart = new Date(Date.UTC(year, 0, 1));
    return year * 100 + Math.ceil((((day - yearStart) / 86400000) + 1) / 7);
  });
  database.aggregate('DECIMAL_SUM', {
    start: null,
    step(total, value) { return value == null ? total : (total ?? 0n) + decimalUnits(value); },
    result(total) { return total === null ? null : unitsDecimal(total); }
  });
  return database;
}

/** Shared MySQL/SQLite query, transaction, and connection lifecycle. */
export class Database {
  #pool;
  #connection;
  #sqlite;
  #ownsDatabase;
  #transactionLock = null;

  constructor(options, connection = null) {
    this.engine = options.engine || 'mysql';
    this.#connection = connection;
    this.#ownsDatabase = connection === null;
    this.#sqlite = this.engine === 'sqlite' ? (connection ?? createSqlite(options.path)) : null;
    if (this.engine === 'mysql' && connection === null) {
      const mysqlOptions = { ...options };
      delete mysqlOptions.engine;
      this.#pool = mysql.createPool(mysqlOptions);
    } else this.#pool = options;
  }

  async query(sql, params = []) {
    if (this.engine === 'mysql') {
      const executor = this.#connection ?? this.#pool;
      const [result] = await executor.execute(sql, params);
      return result;
    }

    if (this.#ownsDatabase && this.#transactionLock) await this.#transactionLock;
    const statementSql = sqliteSql(sql);
    const values = params.map(dateValue);
    const statement = this.#sqlite.prepare(statementSql);
    statement.setReadBigInts(true);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(statementSql)) return normalizeSqliteRows(statement.all(...values));
    const result = statement.run(...values);
    const insertedId = result.lastInsertRowid;
    return { insertId: typeof insertedId === 'bigint' && (insertedId > BigInt(Number.MAX_SAFE_INTEGER) || insertedId < BigInt(Number.MIN_SAFE_INTEGER))
      ? insertedId.toString() : Number(insertedId), affectedRows: Number(result.changes), warningStatus: 0 };
  }

  async transaction(callback) {
    if (!this.#ownsDatabase) throw new Error('Cannot start a transaction from a transaction connection');
    if (this.engine === 'mysql') {
      const connection = await this.#pool.getConnection();
      try {
        await connection.beginTransaction();
        const result = await callback(new Database({ engine: 'mysql' }, connection));
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }

    const previous = this.#transactionLock;
    let unlock;
    const held = new Promise(resolve => { unlock = resolve; });
    const current = previous ? previous.then(() => held) : held;
    this.#transactionLock = current;
    if (previous) await previous;
    let began = false;
    try {
      this.#sqlite.exec('BEGIN IMMEDIATE');
      began = true;
      const result = await callback(new Database({ engine: 'sqlite' }, this.#sqlite));
      this.#sqlite.exec('COMMIT');
      began = false;
      return result;
    } catch (error) {
      if (began) this.#sqlite.exec('ROLLBACK');
      throw error;
    } finally {
      unlock();
      if (this.#transactionLock === current) this.#transactionLock = null;
    }
  }

  async close() {
    if (!this.#ownsDatabase) return;
    if (this.engine === 'mysql') await this.#pool.end();
    else this.#sqlite.close();
  }
}

// Kept for existing integration-test and maintenance callers that create MySQL databases directly.
export function database(options) {
  return new Database({ ...options, engine: 'mysql' });
}
