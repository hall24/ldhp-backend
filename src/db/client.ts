import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/** Driver-agnostic database handle (node-postgres in prod, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

/**
 * Neon Postgres via node-postgres.
 *
 * The API is a long-running Fastify server, so it keeps one pg.Pool for the life of
 * the process (Neon's guidance for long-running Node servers; the serverless driver is
 * for edge/serverless runtimes). Point `connectionString` at Neon's **pooled** URL
 * (`DATABASE_URL`, host ends in `-pooler`) for app traffic. Migrations use the direct
 * URL instead (see `src/db/migrate.ts`).
 */
export function createPgDb(connectionString: string): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    // Neon suspends idle computes (scale to zero). Release idle clients before the
    // server side drops them, and fail fast while a cold compute wakes up.
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });
  // An idle client can be terminated by the server (compute suspend, restart, or
  // pooler recycle). Without this listener pg re-emits it and crashes the process.
  pool.on('error', (err) => {
    console.error('postgres pool: idle client error (will reconnect on next query):', err.message);
  });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}

export { schema };
