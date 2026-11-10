import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, customers, serviceRecords } from '../src/db/schema.js';
import { csvLine, parseCsv } from '../src/lib/csv.js';
import { setup } from './helpers/app.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => t.teardown());

const staff = () => t.as(t.SEED.staffA, t.SEED.orgA);
const owner = () => t.as(t.SEED.ownerA, t.SEED.orgA);
const imp = (csv: string, mode: 'preview' | 'import', extra: Record<string, unknown> = {}, headers = staff()) =>
  t.app.inject({ method: 'POST', url: '/v1/imports/customers', headers, payload: { csv, mode, ...extra } });

const FILE = [
  'Customer Name,E-mail,Phone,Street Address,City,State,ZIP,Service,Last Service Date,Interval Days,Favorite Color',
  'Jane Example,JANE@example.test,555-0100,1 Elm St,Exampleville,NJ,00001,Gutter Cleaning,03/15/2026,365,blue',
  '"Smith, Bob",bob@example.test,,"22 Oak Ave, Unit 2",Exampleville,NJ,00001,window_cleaning,2026-05-01,180,',
  'Smith  Bob,bob@example.test,,,,,,gutter_cleaning,2026-05-01,365,',
  'No Email Home,,,9 Pine Rd,Exampleville,NJ,00002,,,,',
].join('\r\n');

describe('CSV parsing', () => {
  it('handles quotes, commas, newlines in cells, BOM and blank lines', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n\n1,2\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
      ['1', '2'],
    ]);
    expect(() => parseCsv('a\n"open')).toThrow(/line 2/);
  });

  it('neutralises spreadsheet formulas on export', () => {
    expect(csvLine(['=HYPERLINK("x")', '+1555', 'ok', null, 'a,b'])).toBe(`"'=HYPERLINK(""x"")",'+1555,ok,,"a,b"`);
  });
});

describe('customer import', () => {
  it('previews without saving anything', async () => {
    const before = await t.db.select().from(customers).where(eq(customers.organizationId, t.SEED.orgA));
    const res = await imp(FILE, 'preview');
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.applied).toBe(false);
    expect(r.summary).toEqual({
      rows: 4,
      valid_rows: 4,
      error_rows: 0,
      customers_created: 3,
      customers_matched: 1,
      service_records_created: 3,
      service_records_duplicate: 0,
    });
    expect(r.columns.ignored).toEqual(['Favorite Color']);
    expect(r.columns.mapped).toMatchObject({ 'Customer Name': 'display_name', ZIP: 'postal_code', 'Last Service Date': 'completed_on' });
    expect(r.sample.map((s: { customer: string }) => s.customer)).toEqual(['create', 'create', 'match', 'create']);
    const after = await t.db.select().from(customers).where(eq(customers.organizationId, t.SEED.orgA));
    expect(after.length).toBe(before.length);
  });

  it('imports customers and service history, computing due dates, and is safe to repeat', async () => {
    const res = await imp(FILE, 'import');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ applied: true, summary: { customers_created: 3, service_records_created: 3 } });

    const [jane] = await t.db
      .select()
      .from(customers)
      .where(and(eq(customers.organizationId, t.SEED.orgA), eq(customers.email, 'jane@example.test')));
    expect(jane).toMatchObject({ displayName: 'Jane Example', addressLine1: '1 Elm St', region: 'NJ', postalCode: '00001' });
    const [svc] = await t.db.select().from(serviceRecords).where(eq(serviceRecords.customerId, jane!.id));
    expect(svc).toMatchObject({ serviceType: 'gutter_cleaning', completedOn: '2026-03-15', intervalDays: 365, nextDueOn: '2027-03-15' });

    const [bob] = await t.db.select().from(customers).where(eq(customers.email, 'bob@example.test'));
    expect(bob!.displayName).toBe('Smith, Bob');
    expect(await t.db.select().from(serviceRecords).where(eq(serviceRecords.customerId, bob!.id))).toHaveLength(2);

    const again = await imp(FILE, 'import');
    expect(again.json().summary).toMatchObject({
      customers_created: 0,
      customers_matched: 4,
      service_records_created: 0,
      service_records_duplicate: 3,
    });

    const [audit] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'customers.imported'), eq(auditEvents.organizationId, t.SEED.orgA)));
    expect(JSON.stringify(audit)).not.toContain('jane@example.test');
  });

  it('reports row problems, refuses to import them unless asked to skip', async () => {
    const bad = [
      'name,email,service_type,last_service_date,interval_days',
      ',nobody@example.test,,,',
      'Bad Email,not-an-email,,,',
      'Bad Date,,gutters,13/45/2026,',
      'Future,,gutters,2099-01-01,',
      'Two Digit,,gutters,1/2/26,',
      'No Type,,,2026-01-01,',
      'Bad Interval,,gutters,2026-01-01,-5',
      'Fine Row,fine@example.test,gutters,2026-01-01,90',
    ].join('\n');
    const pre = await imp(bad, 'preview');
    expect(pre.json().summary).toMatchObject({ rows: 8, valid_rows: 1, error_rows: 7 });
    expect(pre.json().errors.map((e: { line: number }) => e.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);

    const refused = await imp(bad, 'import');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('import_has_errors');
    expect(await t.db.select().from(customers).where(eq(customers.email, 'fine@example.test'))).toEqual([]);

    const partial = await imp(bad, 'import', { skip_invalid_rows: true });
    expect(partial.json()).toMatchObject({ applied: true, summary: { customers_created: 1 } });
  });

  it('rejects files it cannot read', async () => {
    for (const [csv, code] of [
      ['email,phone\na@example.test,1', 'csv_missing_columns'],
      ['name\n', 'csv_invalid'],
      ['name\n"unclosed', 'csv_invalid'],
    ] as const) {
      const res = await imp(csv, 'preview');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe(code);
    }
  });

  it("can't touch another business's customers through customer_id", async () => {
    const csv = `customer_id,name,service_type,last_service_date\n${t.SEED.homeB1},Hijack,gutters,2026-01-01`;
    const res = await imp(csv, 'import');
    expect(res.json().summary).toMatchObject({ customers_created: 1, customers_matched: 0 });
    const bRecords = await t.db.select().from(serviceRecords).where(eq(serviceRecords.customerId, t.SEED.homeB1));
    expect(bRecords.every((r) => r.organizationId === t.SEED.orgB)).toBe(true);
    expect(bRecords.some((r) => r.serviceType === 'gutters')).toBe(false);
  });
});

describe('customer export', () => {
  it('is owner-only, downloads CSV, and re-imports without duplicates', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/v1/exports/customers.csv', headers: staff() })).statusCode).toBe(403);
    const res = await t.app.inject({ method: 'GET', url: '/v1/exports/customers.csv', headers: owner() });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="customers-\d{4}-\d{2}-\d{2}\.csv"/);
    const rows = parseCsv(res.body);
    expect(rows[0]).toContain('last_service_date');
    expect(res.body).toContain('"Smith, Bob"');
    // Org B's customers never appear.
    expect(res.body).not.toContain(t.SEED.homeB1);

    const round = await imp(res.body, 'preview');
    expect(round.statusCode).toBe(200);
    expect(round.json().summary).toMatchObject({ error_rows: 0, customers_created: 0, service_records_created: 0 });
    expect(round.json().columns.ignored).toEqual(['suppressed', 'next_due_on']);
  });
});
