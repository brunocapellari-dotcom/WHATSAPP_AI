import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
try {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = resolve('db/migrations');
  const files = (await readdir(dir)).filter((x) => x.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [file]);
    if (done.rowCount) continue;
    const sql = await readFile(resolve(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [file]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
} finally { await pool.end(); }
