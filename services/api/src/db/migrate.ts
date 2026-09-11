import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function migrate(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required');
  }

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT now()
      )
    `);

    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name')).rows.map(
        (r) => r.name,
      ),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');
      console.log(`[migrate] applying ${file}`);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('[migrate] done');
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error('[migrate] fatal:', err);
  process.exit(1);
});
