// PostgreSQL holds the master data (faculty, rooms, sections, courses, offerings,
// constraints, users). It's relational data with lots of foreign keys, which is
// exactly what SQL is good at.
import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

// Return DATE columns as plain 'YYYY-MM-DD' strings. The default turns them into
// JS Dates at local midnight, which can shift the day when converted to UTC.
pg.types.setTypeParser(1082, (v) => v);
// COUNT(*) comes back as BIGINT (a string); our counts are always small.
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  ssl: env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => logger.error('Postgres pool error', { err: err.message }));

export const query = (text, params) => pool.query(text, params);

/** Run several queries atomically: all succeed or none do. */
export async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
