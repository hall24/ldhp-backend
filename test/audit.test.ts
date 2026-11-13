import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './helpers/db.js';
import { recordAudit } from '../src/services/audit.js';
import { auditEvents } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';

let db: Db;

/** Drizzle wraps driver errors; the Postgres message is on `cause`. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return err.cause?.message ?? err.message;
  }
  return 'no error';
}
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb({ as: 'owner' }));
  await recordAudit(db, { actor: { type: 'system', accountId: null }, organizationId: null, action: 'test.event' });
});
afterAll(async () => close());

describe('audit_events is append-only', () => {
  it('allows inserts', async () => {
    const rows = await db.select().from(auditEvents);
    expect(rows).toHaveLength(1);
  });
  it('blocks UPDATE', async () => {
    expect(await pgError(db.execute(sql`UPDATE audit_events SET action = 'tampered'`))).toMatch(/append-only/);
  });
  it('blocks DELETE', async () => {
    expect(await pgError(db.execute(sql`DELETE FROM audit_events`))).toMatch(/append-only/);
  });
  it('leaves the original row intact', async () => {
    const rows = await db.select().from(auditEvents);
    expect(rows.map((r) => r.action)).toEqual(['test.event']);
  });
  it('blocks TRUNCATE', async () => {
    expect(await pgError(db.execute(sql`TRUNCATE audit_events`))).toMatch(/append-only/);
  });
});
