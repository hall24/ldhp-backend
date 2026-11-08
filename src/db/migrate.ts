import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_MIGRATION_URL (or DATABASE_URL) is required');
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
await migrate(drizzle(pool), { migrationsFolder: 'drizzle' });
await pool.end();
console.log('migrations applied');
