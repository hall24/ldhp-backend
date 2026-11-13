import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './helpers/db.js';
import { recordAudit } from '../src/services/audit.js';
import type { Db } from '../src/db/client.js';

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return err.cause?.message ?? err.message;
  }
  return 'no error';
}

describe('least-privilege app role', () => {
  it('is what the tests (and the API) run as', async () => {
    const r = await db.execute(sql`select current_user as u`);
    const rows = (r as unknown as { rows: { u: string }[] }).rows;
    expect(rows[0]!.u).toBe('ldhp_app');
  });

  it('can append to the audit trail but not change it', async () => {
    await recordAudit(db, { actor: { type: 'system', accountId: null }, organizationId: null, action: 'role.test' });
    expect(await pgError(db.execute(sql`UPDATE audit_events SET action = 'x'`))).toMatch(/permission denied/);
    expect(await pgError(db.execute(sql`DELETE FROM audit_events`))).toMatch(/permission denied/);
    expect(await pgError(db.execute(sql`TRUNCATE audit_events`))).toMatch(/permission denied/);
  });

  it('cannot change the schema, wipe tables, or grant itself more', async () => {
    for (const stmt of [
      sql`CREATE TABLE evil (id int)`,
      sql`DROP TABLE customers`,
      sql`ALTER TABLE customers ADD COLUMN x int`,
      sql`TRUNCATE customers`,
      sql`DROP TRIGGER audit_events_no_update_delete ON audit_events`,
      sql`CREATE ROLE sneaky`,
      sql`ALTER ROLE ldhp_app CREATEROLE`,
    ]) {
      expect(await pgError(db.execute(stmt))).not.toBe('no error');
    }
  });
});
