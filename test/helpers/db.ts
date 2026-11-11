import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema.js';
import type { Db } from '../../src/db/client.js';

/**
 * Fresh in-process Postgres with all migrations applied (as the owner, like a deploy).
 * By default the connection then switches to the least-privilege `ldhp_app` role, so
 * every test proves the API works with only the access production gives it.
 */
export async function createTestDb(
  opts: { as?: 'app' | 'owner' } = {},
): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: 'drizzle' });
  if ((opts.as ?? 'app') === 'app') await db.execute(sql`SET ROLE ldhp_app`);
  return { db: db as unknown as Db, close: () => client.close() };
}
