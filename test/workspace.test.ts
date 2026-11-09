import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, memberships, organizations } from '../src/db/schema.js';
import { setup } from './helpers/app.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => t.teardown());

const newUser = { clerkUserId: 'user_test_new_pro' };

describe('workspace setup', () => {
  let orgId: string;

  it('lets a signed-in user create a workspace and become its owner', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: t.as(newUser),
      payload: {
        name: 'New Pro Gutters',
        time_zone: 'America/Denver',
        message_from_name: 'New Pro',
        service_types: ['gutter_cleaning', ' roof_inspection '],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      name: 'New Pro Gutters',
      time_zone: 'America/Denver',
      role: 'owner',
      service_types: ['gutter_cleaning', 'roof_inspection'],
    });
    orgId = body.id;

    const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: t.as(newUser) });
    expect(me.json().memberships).toEqual([expect.objectContaining({ organization_id: orgId, role: 'owner' })]);

    const [ev] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'organization.created'), eq(auditEvents.organizationId, orgId)));
    expect(ev).toBeTruthy();
  });

  it('returns the same workspace when a signup is retried with the same Idempotency-Key', async () => {
    const req = {
      method: 'POST' as const,
      url: '/v1/organizations',
      headers: { ...t.as(newUser), 'idempotency-key': 'signup-1' },
      payload: { name: 'Retry Co' },
    };
    const a = await t.app.inject(req);
    const b = await t.app.inject(req);
    expect(a.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    const rows = await t.db.select().from(organizations).where(eq(organizations.name, 'Retry Co'));
    expect(rows).toHaveLength(1);
  });

  it('rejects an unknown time zone', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: t.as(newUser),
      payload: { name: 'Bad TZ', time_zone: 'Mars/Olympus' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('requires sign-in', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/organizations', payload: { name: 'x' } });
    expect(res.statusCode).toBe(401);
  });

  it('shows settings to members and lets only owners change them', async () => {
    const get = await t.app.inject({
      method: 'GET',
      url: '/v1/organization',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: t.SEED.orgA, role: 'staff' });

    const staffPatch = await t.app.inject({
      method: 'PATCH',
      url: '/v1/organization',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { name: 'Hijacked' },
    });
    expect(staffPatch.statusCode).toBe(403);

    const ownerPatch = await t.app.inject({
      method: 'PATCH',
      url: '/v1/organization',
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
      payload: { service_area: 'Exampleville and nearby', service_types: ['gutter_cleaning'] },
    });
    expect(ownerPatch.statusCode).toBe(200);
    expect(ownerPatch.json()).toMatchObject({
      name: 'Test Gutter & Window Co',
      service_area: 'Exampleville and nearby',
      service_types: ['gutter_cleaning'],
    });
  });

  it('cannot read or change another workspace settings', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/v1/organization',
      headers: t.as(t.SEED.ownerA, t.SEED.orgB),
      payload: { name: 'Taken over' },
    });
    expect(res.statusCode).toBe(403);
    const [b] = await t.db.select().from(organizations).where(eq(organizations.id, t.SEED.orgB));
    expect(b!.name).toBe('Sample HVAC Services');
  });

  it('makes the creator the only member of the new workspace', async () => {
    const rows = await t.db.select().from(memberships).where(eq(memberships.organizationId, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('owner');
  });
});

describe('customer editing', () => {
  it('edits only the fields sent and audits without contact values', async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${t.SEED.homeA2}`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { email: 'changed@example.test', address: { city: 'Newtown' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      display_name: 'Test Home Two',
      email: 'changed@example.test',
      address: { line1: '200 Placeholder Ave', city: 'Newtown' },
    });
    const evs = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.recordId, t.SEED.homeA2), eq(auditEvents.action, 'customer.updated')));
    expect(evs).toHaveLength(1);
    expect(JSON.stringify(evs[0])).not.toContain('changed@example.test');
    expect(evs[0]!.before).toMatchObject({ has_email: false });
    expect(evs[0]!.after).toMatchObject({ has_email: true });
  });

  it('suppresses and unsuppresses a customer from the due queue', async () => {
    const suppress = await t.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${t.SEED.homeA1}`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { suppressed: true },
    });
    expect(suppress.json().suppressed).toBe(true);
    const due = await t.app.inject({ method: 'GET', url: '/v1/due-queue', headers: t.as(t.SEED.staffA, t.SEED.orgA) });
    expect(due.json().data.some((i: { customer_id: string }) => i.customer_id === t.SEED.homeA1)).toBe(false);

    await t.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${t.SEED.homeA1}`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { suppressed: false },
    });
    const actions = (
      await t.db.select({ a: auditEvents.action }).from(auditEvents).where(eq(auditEvents.recordId, t.SEED.homeA1))
    ).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(['customer.suppressed', 'customer.unsuppressed']));
  });

  it('rejects an empty patch and unknown fields', async () => {
    for (const payload of [{}, { organization_id: t.SEED.orgB }]) {
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/v1/customers/${t.SEED.homeA2}`,
        headers: t.as(t.SEED.staffA, t.SEED.orgA),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("returns 404 when editing another org's customer and leaves it unchanged", async () => {
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${t.SEED.homeB1}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
      payload: { display_name: 'Overwritten' },
    });
    expect(res.statusCode).toBe(404);
    const check = await t.app.inject({
      method: 'GET',
      url: `/v1/customers/${t.SEED.homeB1}`,
      headers: t.as(t.SEED.ownerB, t.SEED.orgB),
    });
    expect(check.json().display_name).toBe('Other Org Home');
  });

  it('lets owners (not staff) delete a customer, which then disappears', async () => {
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { display_name: 'To Be Deleted' },
    });
    const id = created.json().id;
    const staff = await t.app.inject({
      method: 'DELETE',
      url: `/v1/customers/${id}`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(staff.statusCode).toBe(403);
    const owner = await t.app.inject({
      method: 'DELETE',
      url: `/v1/customers/${id}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
    });
    expect(owner.statusCode).toBe(204);
    const get = await t.app.inject({
      method: 'GET',
      url: `/v1/customers/${id}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
    });
    expect(get.statusCode).toBe(404);

    const cross = await t.app.inject({
      method: 'DELETE',
      url: `/v1/customers/${t.SEED.homeB1}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
    });
    expect(cross.statusCode).toBe(404);
  });
});

describe('service record corrections', () => {
  async function newRecord(payload: Record<string, unknown>) {
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeA2}/service-records`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  }
  const patch = (id: string, payload: Record<string, unknown>, customer: string = t.SEED.homeA2) =>
    t.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${customer}/service-records/${id}`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload,
    });

  it('recomputes next_due_on when the completion date is corrected', async () => {
    const r = await newRecord({ service_type: 'pressure_wash', completed_on: '2026-01-01', interval_days: 90 });
    const res = await patch(r.id, { completed_on: '2026-02-01' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ completed_on: '2026-02-01', next_due_on: '2026-05-02' });

    const [ev] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.recordId, r.id), eq(auditEvents.action, 'service.updated')));
    expect(ev!.before).toMatchObject({ completed_on: '2026-01-01' });
    expect(ev!.after).toMatchObject({ completed_on: '2026-02-01' });
  });

  it('accepts an explicit due date override, and null clears it', async () => {
    const r = await newRecord({ service_type: 'pressure_wash', completed_on: '2026-03-01', interval_days: 30 });
    const set = await patch(r.id, { next_due_on: '2026-06-15' });
    expect(set.json().next_due_on).toBe('2026-06-15');
    const cleared = await patch(r.id, { next_due_on: null });
    expect(cleared.json().next_due_on).toBeNull();
    const bad = await patch(r.id, { next_due_on: '2026-02-30' });
    expect(bad.statusCode).toBe(400);
  });

  it('returns 404 for a record under a different customer or org', async () => {
    const r = await newRecord({ service_type: 'pressure_wash', completed_on: '2026-03-01' });
    expect((await patch(r.id, { notes: 'x' }, t.SEED.homeA1)).statusCode).toBe(404);
    const cross = await t.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${t.SEED.homeA2}/service-records/${r.id}`,
      headers: t.as(t.SEED.ownerB, t.SEED.orgB),
      payload: { notes: 'x' },
    });
    expect(cross.statusCode).toBe(404);
  });

  it('deletes a record entered in error', async () => {
    const r = await newRecord({ service_type: 'mistake', completed_on: '2026-03-01' });
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/v1/customers/${t.SEED.homeA2}/service-records/${r.id}`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(del.statusCode).toBe(204);
    const list = await t.app.inject({
      method: 'GET',
      url: `/v1/customers/${t.SEED.homeA2}/service-records`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(list.json().data.some((x: { id: string }) => x.id === r.id)).toBe(false);
    expect((await patch(r.id, { notes: 'x' })).statusCode).toBe(404);
  });
});
