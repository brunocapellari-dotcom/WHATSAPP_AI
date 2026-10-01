import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { importGlobalCanonicalEntityBatch } from '../src/freight/canonical-import.js';

const config = loadConfig();
const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error('Usage: npm run data:import:entities -- <canonical-entities.ndjson>');
}
if (config.NODE_ENV === 'production' && !config.MIGRATION_DATABASE_URL) {
  throw new Error('MIGRATION_DATABASE_URL is required for global canonical imports in production');
}

const pool = new Pool({
  connectionString: config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL,
  application_name: 'whatsapp-ai-canonical-entity-import',
});

const stream = createReadStream(inputPath, { encoding: 'utf8' });
const lines = createInterface({ input: stream, crlfDelay: Infinity });
const batch: unknown[] = [];
let lineNumber = 0;
let imported = 0;

async function flush() {
  if (batch.length === 0) return;
  imported += await importGlobalCanonicalEntityBatch(pool, batch.splice(0, batch.length));
}

try {
  for await (const line of lines) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `canonical_import_invalid_json_line:${lineNumber}:${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
    batch.push(parsed);
    if (batch.length >= 500) await flush();
  }

  await flush();
  console.log(JSON.stringify({
    format: 'CANONICAL_ENTITY_NDJSON_V1',
    inputPath,
    imported,
    lines: lineNumber,
  }));
} finally {
  await pool.end();
}
