import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

/** Apply all migrations as the owner, run the grants script, then act as the app role. */
describe('least-privilege app role (scripts/sql/app-role-grants.sql)', () => {
  it('can use rows but not change schema or rewrite audit history', async () => {
    const pg = new PGlite();
    await pg.exec(`CREATE ROLE neondb_owner; CREATE ROLE ldhp_app;`);
    await pg.exec(`GRANT ALL ON SCHEMA public TO neondb_owner; CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION neondb_owner; SET ROLE neondb_owner;`);
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync('drizzle').filter((n) => n.endsWith('.sql')).sort()) {
      for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (stmt.trim()) await pg.exec(stmt);
      }
    }
    await pg.exec(`CREATE TABLE drizzle.__drizzle_migrations (id serial primary key);`);
    await pg.exec(`RESET ROLE;`);
    const script = readFileSync('scripts/sql/app-role-grants.sql', 'utf8').replace(/DATABASE neondb\b/, 'DATABASE postgres');
    await pg.exec(script);
    await pg.exec(script); // idempotent

    await pg.exec(`SET ROLE ldhp_app;`);
    await expect(pg.exec(`SELECT count(*) FROM customers`)).resolves.toBeTruthy();
    await expect(pg.exec(`SELECT count(*) FROM audit_events`)).resolves.toBeTruthy();
    await expect(pg.exec(`CREATE TABLE nope (id int)`)).rejects.toThrow(/permission denied/);
    await expect(pg.exec(`DROP TABLE customers`)).rejects.toThrow(/must be owner/);
    await expect(pg.exec(`DELETE FROM audit_events`)).rejects.toThrow(/permission denied/);
    await expect(pg.exec(`SELECT * FROM drizzle.__drizzle_migrations`)).rejects.toThrow(/permission denied/);

    // A table added by a later migration is usable without re-running the script.
    await pg.exec(`RESET ROLE; SET ROLE neondb_owner; CREATE TABLE later_table (id int); RESET ROLE; SET ROLE ldhp_app;`);
    await expect(pg.exec(`INSERT INTO later_table VALUES (1)`)).resolves.toBeTruthy();
    await pg.close();
  });
});
