import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup } from './helpers/app.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => t.teardown());

const owner = () => t.as(t.SEED.ownerA, t.SEED.orgA);
const staff = () => t.as(t.SEED.staffA, t.SEED.orgA);
const patchOrg = (payload: Record<string, unknown>, headers = owner()) =>
  t.app.inject({ method: 'PATCH', url: '/v1/organization', headers, payload });
const dueQueue = () => t.app.inject({ method: 'GET', url: '/v1/due-queue?within_days=30', headers: staff() });

describe('booking link and job values in workspace settings', () => {
  it('starts empty', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/organization', headers: staff() });
    expect(res.json()).toMatchObject({ booking_url: null, job_values_cents: {} });
  });

  it('owners can set both; values are returned and audited', async () => {
    const res = await patchOrg({
      booking_url: 'https://clienthub.example.test/book',
      job_values_cents: { gutter_cleaning: 25000, window_washing: 18000 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      booking_url: 'https://clienthub.example.test/book',
      job_values_cents: { gutter_cleaning: 25000, window_washing: 18000 },
    });
    const audit = await t.app.inject({ method: 'GET', url: '/v1/audit-events', headers: owner() });
    const ev = audit.json().data.find((e: { action: string }) => e.action === 'organization.updated');
    expect(ev).toBeTruthy();
  });

  it('rejects non-https booking links', async () => {
    for (const booking_url of ['http://example.test/book', 'javascript:alert(1)', 'https://user:pw@example.test/']) {
      const res = await patchOrg({ booking_url });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects negative or fractional amounts', async () => {
    expect((await patchOrg({ job_values_cents: { gutter_cleaning: -1 } })).statusCode).toBe(400);
    expect((await patchOrg({ job_values_cents: { gutter_cleaning: 10.5 } })).statusCode).toBe(400);
  });

  it('staff cannot change them', async () => {
    expect((await patchOrg({ booking_url: null }, staff())).statusCode).toBe(403);
  });
});

describe('due queue estimate', () => {
  it('adds a per-item value and a summary total', async () => {
    await patchOrg({ job_values_cents: { gutter_cleaning: 25000 } });
    const res = await dueQueue();
    expect(res.statusCode).toBe(200);
    const { data, summary } = res.json() as {
      data: Array<{ service_type: string; status: string; estimated_value_cents: number | null }>;
      summary: Record<string, unknown>;
    };
    for (const i of data) {
      expect(i.estimated_value_cents).toBe(i.service_type === 'gutter_cleaning' ? 25000 : null);
    }
    const gutters = data.filter((i) => i.service_type === 'gutter_cleaning').length;
    expect(gutters).toBeGreaterThan(0);
    expect(summary).toEqual({
      overdue: data.filter((i) => i.status === 'overdue').length,
      due_soon: data.filter((i) => i.status === 'due_soon').length,
      estimated_value_cents: gutters * 25000,
      items_without_value: data.length - gutters,
      currency: 'USD',
    });
  });

  it('returns a null estimate when no values are set', async () => {
    await patchOrg({ job_values_cents: {} });
    const res = await dueQueue();
    expect(res.json().summary.estimated_value_cents).toBeNull();
  });
});

describe('booking link on the customer response page', () => {
  it('is returned by view and respond when set, and null otherwise', async () => {
    await patchOrg({ booking_url: 'https://clienthub.example.test/book' });
    const link = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeA1}/intake-requests`,
      headers: staff(),
      payload: { service_type: 'gutter_cleaning' },
    });
    const token = link.json().link_token as string;
    const view = await t.app.inject({ method: 'POST', url: '/v1/public/intake/view', payload: { token } });
    expect(view.json().booking_url).toBe('https://clienthub.example.test/book');
    const respond = await t.app.inject({
      method: 'POST',
      url: '/v1/public/intake/respond',
      payload: { token, response: 'request_service' },
    });
    expect(respond.statusCode).toBe(200);
    expect(respond.json().booking_url).toBe('https://clienthub.example.test/book');

    await patchOrg({ booking_url: null });
    const again = await t.app.inject({ method: 'POST', url: '/v1/public/intake/view', payload: { token } });
    expect(again.json().booking_url).toBeNull();
  });
});
