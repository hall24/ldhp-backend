import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, customers, memberships } from '../src/db/schema.js';
import { setup } from './helpers/app.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => t.teardown());

describe('authentication', () => {
  it('serves health without auth', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('serves database readiness without auth', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/health/db' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', database: 'ok' });
  });

  it('rejects missing and invalid tokens with the error envelope', async () => {
    const none = await t.app.inject({ method: 'GET', url: '/v1/me' });
    expect(none.statusCode).toBe(401);
    expect(none.json().error).toMatchObject({ code: 'unauthenticated' });
    expect(none.json().error.request_id).toBeTruthy();

    const bad = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
  });

  it('returns the caller memberships from /me', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: t.as(t.SEED.staffA) });
    expect(res.statusCode).toBe(200);
    expect(res.json().memberships).toEqual([
      expect.objectContaining({ organization_id: t.SEED.orgA, role: 'staff' }),
    ]);
  });

  it('provisions an account with no org access for a new Clerk user', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: t.as({ clerkUserId: 'user_brand_new' }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().memberships).toEqual([]);
  });
});

describe('organization scope', () => {
  it('requires an organization header on tenant routes', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/customers', headers: t.as(t.SEED.ownerA) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('organization_required');
  });

  it('denies and audits access to an org the caller is not a member of', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: t.as(t.SEED.ownerB, t.SEED.orgA),
    });
    expect(res.statusCode).toBe(403);
    const denied = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'authz.org_access_denied'), eq(auditEvents.actorAccountId, t.SEED.ownerB.id)));
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]!.outcome).toBe('denied');
  });

  it('gives the same answer for a non-existent org and a non-member org', async () => {
    const fake = await t.app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: t.as(t.SEED.ownerA, '00000000-0000-4000-8000-000000000000'),
    });
    const other = await t.app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: t.as(t.SEED.ownerA, t.SEED.orgB),
    });
    expect(fake.statusCode).toBe(403);
    expect(other.statusCode).toBe(403);
    expect(fake.json().error.message).toBe(other.json().error.message);
  });

  it('lists only the caller org customers, with cursor pagination', async () => {
    const p1 = await t.app.inject({
      method: 'GET',
      url: '/v1/customers?limit=1',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().data).toHaveLength(1);
    const cursor = p1.json().next_cursor;
    expect(cursor).toBeTruthy();
    const p2 = await t.app.inject({
      method: 'GET',
      url: `/v1/customers?limit=100&cursor=${cursor}`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    const ids = [...p1.json().data, ...p2.json().data].map((c: { id: string }) => c.id);
    expect(ids).toContain(t.SEED.homeA1);
    expect(ids).toContain(t.SEED.homeA2);
    expect(ids).not.toContain(t.SEED.homeB1);
  });

  it("returns 404 (not 403) for another org's record so existence is not leaked", async () => {
    for (const url of [`/v1/customers/${t.SEED.homeB1}`, `/v1/customers/${t.SEED.homeB1}/service-records`]) {
      const res = await t.app.inject({ method: 'GET', url, headers: t.as(t.SEED.ownerA, t.SEED.orgA) });
      expect(res.statusCode).toBe(404);
    }
  });

  it('cannot write a service record onto another org customer', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeB1}/service-records`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
      payload: { service_type: 'gutter_cleaning', completed_on: '2026-10-01' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('cuts off access immediately when a membership is revoked', async () => {
    const before = await t.app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(before.statusCode).toBe(200);
    await t.db
      .update(memberships)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(memberships.accountId, t.SEED.staffA.id));
    const after = await t.app.inject({
      method: 'GET',
      url: '/v1/customers',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(after.statusCode).toBe(403);
    await t.db
      .update(memberships)
      .set({ status: 'active', revokedAt: null })
      .where(eq(memberships.accountId, t.SEED.staffA.id));
  });
});

describe('customers and service records', () => {
  it('creates a customer and writes an audit event without contact values', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { display_name: 'New Test Customer', email: 'new@example.test', address: { city: 'Exampleville' } },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.address.city).toBe('Exampleville');
    const [ev] = await t.db.select().from(auditEvents).where(eq(auditEvents.recordId, body.id));
    expect(ev).toMatchObject({
      action: 'customer.created',
      actorType: 'user',
      actorAccountId: t.SEED.staffA.id,
      organizationId: t.SEED.orgA,
    });
    expect(JSON.stringify(ev!.after)).not.toContain('new@example.test');
    expect(ev!.requestId).toBe(res.headers['x-request-id']);
  });

  it('rejects unknown fields and bad input', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/customers',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { display_name: 'X', organization_id: t.SEED.orgB },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('replays idempotent retries instead of creating duplicates', async () => {
    const req = {
      method: 'POST' as const,
      url: '/v1/customers',
      headers: { ...t.as(t.SEED.staffA, t.SEED.orgA), 'idempotency-key': 'retry-key-1' },
      payload: { display_name: 'Idempotent Customer' },
    };
    const first = await t.app.inject(req);
    const second = await t.app.inject(req);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);
    const rows = await t.db.select().from(customers).where(eq(customers.displayName, 'Idempotent Customer'));
    expect(rows).toHaveLength(1);

    const conflicting = await t.app.inject({ ...req, payload: { display_name: 'Different' } });
    expect(conflicting.statusCode).toBe(422);
  });

  it('computes next_due_on from the interval', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeA2}/service-records`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { service_type: 'window_washing', completed_on: '2026-01-31', interval_days: 30 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ next_due_on: '2026-03-02', interval_days: 30 });
  });
});

describe('due queue', () => {
  it('lists overdue and due-soon services for the org only, latest record per service type', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/due-queue?within_days=30',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().data as Array<Record<string, unknown>>;
    const forHome1 = items.filter((i) => i.customer_id === t.SEED.homeA1);
    expect(forHome1.map((i) => [i.service_type, i.status, i.days_until_due])).toEqual([
      ['gutter_cleaning', 'overdue', -10],
      ['window_washing', 'due_soon', 10],
    ]);
    expect(items.some((i) => i.customer_id === t.SEED.homeB1)).toBe(false);
  });

  it('excludes suppressed customers', async () => {
    await t.db.update(customers).set({ suppressed: true }).where(eq(customers.id, t.SEED.homeA1));
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/due-queue',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(res.json().data.some((i: { customer_id: string }) => i.customer_id === t.SEED.homeA1)).toBe(false);
    await t.db.update(customers).set({ suppressed: false }).where(eq(customers.id, t.SEED.homeA1));
  });
});

describe('audit trail endpoint', () => {
  it('is owner-only and audits the role denial', async () => {
    const staff = await t.app.inject({
      method: 'GET',
      url: '/v1/audit-events',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
    });
    expect(staff.statusCode).toBe(403);
    const owner = await t.app.inject({
      method: 'GET',
      url: '/v1/audit-events',
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
    });
    expect(owner.statusCode).toBe(200);
    const actions = owner.json().data.map((e: { action: string }) => e.action);
    expect(actions).toContain('authz.role_denied');
    expect(actions).toContain('customer.created');
  });
});
