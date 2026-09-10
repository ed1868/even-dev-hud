import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export { pool };
