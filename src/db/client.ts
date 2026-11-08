import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/** Driver-agnostic database handle (node-postgres in prod, PGlite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createPgDb(connectionString: string): { db: Db; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, close: () => pool.end() };
}

export { schema };
