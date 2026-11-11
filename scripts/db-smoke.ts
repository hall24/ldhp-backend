/**
 * End-to-end check of the Neon Postgres wiring. Safe to run against any branch:
 * the write happens inside a transaction that is always rolled back.
 *
 *   npm run db:smoke
 */
import { eq, sql } from 'drizzle-orm';
import { createPgDb } from '../src/db/client.js';
import { organizations } from '../src/db/schema.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (run `neon env pull` or `neon deploy` first)');
  process.exit(1);
}

const host = new URL(url).hostname;
console.log(`host: ${host} (${host.includes('-pooler') ? 'pooled' : 'direct'})`);

const { db, close } = createPgDb(url);
const ROLLBACK = new Error('smoke rollback');
try {
  const [info] = (
    (await db.execute(sql`select version() as version, current_database() as db`)) as {
      rows: { version: string; db: string }[];
    }
  ).rows;
  console.log(`connected: ${info?.db} / ${info?.version.split(',')[0]}`);

  const [who] = (
    (await db.execute(
      sql`select current_user as u, has_schema_privilege(current_user, 'public', 'CREATE') as can_ddl`,
    )) as { rows: { u: string; can_ddl: boolean }[] }
  ).rows;
  console.log(`role: ${who?.u}${who?.can_ddl ? ' (can change the schema: owner/migrator)' : ' (rows only: app role)'}`);

  try {
    const [mig] = (
      (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)) as {
        rows: { n: number }[];
      }
    ).rows;
    console.log(`migrations applied: ${mig?.n}`);
  } catch {
    console.log('migrations table: not visible to this role (expected for ldhp_app)');
  }

  try {
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(organizations)
        .values({ name: 'smoke-test (rolled back)' })
        .returning({ id: organizations.id });
      const [back] = await tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, row!.id));
      console.log(`write/read in transaction: ${back?.name === 'smoke-test (rolled back)' ? 'ok' : 'MISMATCH'}`);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  console.log('db smoke: PASS');
} catch (err) {
  console.error('db smoke: FAIL', err);
  process.exitCode = 1;
} finally {
  await close();
}
