import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, consentRecords, intakeRequests } from '../src/db/schema.js';
import { checkEligibility } from '../src/services/consent.js';
import { setup } from './helpers/app.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => t.teardown());

const staff = () => t.as(t.SEED.staffA, t.SEED.orgA);

async function newLink(customerId: string = t.SEED.homeA1, service_type: string | null = 'gutter_cleaning') {
  const res = await t.app.inject({
    method: 'POST',
    url: `/v1/customers/${customerId}/intake-requests`,
    headers: staff(),
    payload: { service_type },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { intake_request: { id: string; status: string; link_state: string }; link_token: string };
}

const view = (token: string) =>
  t.app.inject({ method: 'POST', url: '/v1/public/intake/view', payload: { token } });
const respond = (token: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: 'POST', url: '/v1/public/intake/respond', payload: { token, ...payload } });

describe('consent records', () => {
  it('records consent defaulting to the customer email, normalized', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeA1}/consents`,
      headers: staff(),
      payload: { channel: 'email', purpose: 'marketing', source: 'paper_form' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ contact_value: 'home1@example.test', status: 'active' });
  });

  it('requires a contact value when the customer has none on file', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeA2}/consents`,
      headers: staff(),
      payload: { channel: 'sms', purpose: 'service_reminders', source: 'web_form' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('applies the eligibility rules: SMS needs opt-in, any opt-out blocks', async () => {
    const db = t.db;
    const org = t.SEED.orgA;
    expect(await checkEligibility(db, org, 'sms', '+1 555 555 0101', 'service_reminders')).toEqual({
      eligible: false,
      reason: 'no_consent',
    });
    expect(await checkEligibility(db, org, 'email', 'HOME1@example.test', 'service_reminders')).toMatchObject({
      eligible: true,
    });
    expect(await checkEligibility(db, org, 'email', 'home1@example.test', 'marketing')).toMatchObject({
      eligible: true,
      consentRecordId: expect.any(String),
    });
    expect(await checkEligibility(db, org, 'email', null, 'service_reminders')).toEqual({
      eligible: false,
      reason: 'no_contact',
    });

    const sms = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeA1}/consents`,
      headers: staff(),
      payload: { channel: 'sms', purpose: 'service_reminders', source: 'web_form' },
    });
    expect(await checkEligibility(db, org, 'sms', '+15555550101', 'service_reminders')).toMatchObject({
      eligible: true,
    });

    const withdraw = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeA1}/consents/${sms.json().id}/withdraw`,
      headers: staff(),
      payload: { source: 'phone_call' },
    });
    expect(withdraw.json()).toMatchObject({ status: 'withdrawn', withdrawal_source: 'phone_call' });
    expect(await checkEligibility(db, org, 'sms', '+15555550101', 'service_reminders')).toEqual({
      eligible: false,
      reason: 'opted_out',
    });
    // Another business is unaffected by org A's records.
    expect(await checkEligibility(db, t.SEED.orgB, 'email', 'home1@example.test', 'marketing')).toEqual({
      eligible: false,
      reason: 'no_consent',
    });
  });

  it("hides another org's customer consents", async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/v1/customers/${t.SEED.homeB1}/consents`,
      headers: staff(),
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('customer response link', () => {
  it('stores only a hash and shows the customer the business, nothing else', async () => {
    const { intake_request, link_token } = await newLink();
    expect(intake_request).toMatchObject({ status: 'awaiting_response', link_state: 'active' });
    const [row] = await t.db.select().from(intakeRequests).where(eq(intakeRequests.id, intake_request.id));
    expect(JSON.stringify(row)).not.toContain(link_token);

    const res = await view(link_token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ business_name: 'Test Gutter Co', service_type: 'gutter_cleaning', can_respond: true });
    const body = JSON.stringify(res.json());
    for (const leak of ['Test Home One', 'home1@example.test', '100 Synthetic Way', t.SEED.homeA1, intake_request.id]) {
      expect(body).not.toContain(leak);
    }
  });

  it('records the answer, lets the customer change it, and queues it for staff', async () => {
    const { intake_request, link_token } = await newLink();
    const first = await respond(link_token, { response: 'contact_me', note: 'Call after 5pm' });
    expect(first.statusCode).toBe(200);
    const second = await respond(link_token, { response: 'request_service' });
    expect(second.statusCode).toBe(200);

    const detail = await t.app.inject({ method: 'GET', url: `/v1/intake-requests/${intake_request.id}`, headers: staff() });
    expect(detail.json()).toMatchObject({ status: 'received', response: 'request_service', customer_name: 'Test Home One' });
    expect(detail.json().history.map((h: { to_status: string }) => h.to_status)).toEqual([
      'awaiting_response',
      'received',
      'received',
    ]);
    expect(detail.json().history[1]).toMatchObject({ actor_type: 'customer_link', actor_account_id: null });

    const queue = await t.app.inject({ method: 'GET', url: '/v1/intake-requests?status=received', headers: staff() });
    expect(queue.json().data.some((r: { id: string }) => r.id === intake_request.id)).toBe(true);
  });

  it('gives one answer for unknown, malformed, expired and revoked links', async () => {
    const expired = await newLink();
    await t.db
      .update(intakeRequests)
      .set({ linkExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(intakeRequests.id, expired.intake_request.id));

    const revoked = await newLink();
    const rv = await t.app.inject({
      method: 'POST',
      url: `/v1/intake-requests/${revoked.intake_request.id}/revoke-link`,
      headers: staff(),
    });
    expect(rv.json().link_state).toBe('revoked');

    const results = await Promise.all([
      view('B'.repeat(43)),
      view('nope'),
      view(expired.link_token),
      view(revoked.link_token),
      respond(revoked.link_token, { response: 'decline' }),
    ]);
    for (const r of results) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('link_invalid');
    }
  });

  it('stops accepting answers once staff are following up', async () => {
    const { intake_request, link_token } = await newLink();
    await respond(link_token, { response: 'request_service' });
    await t.app.inject({
      method: 'PATCH',
      url: `/v1/intake-requests/${intake_request.id}`,
      headers: staff(),
      payload: { status: 'contacted', note: 'Left voicemail' },
    });
    const late = await respond(link_token, { response: 'decline' });
    expect(late.statusCode).toBe(409);
    expect((await view(link_token)).json().can_respond).toBe(false);
  });

  it('unsubscribe from the link blocks future email to that customer', async () => {
    const { link_token } = await newLink(t.SEED.homeA1);
    const res = await respond(link_token, { response: 'decline', unsubscribe: true });
    expect(res.statusCode).toBe(200);
    expect(await checkEligibility(t.db, t.SEED.orgA, 'email', 'home1@example.test', 'service_reminders')).toEqual({
      eligible: false,
      reason: 'opted_out',
    });
    const rows = await t.db
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.customerId, t.SEED.homeA1), eq(consentRecords.channel, 'email')));
    expect(rows.every((r) => r.withdrawnAt)).toBe(true);
  });

  it('does not reveal the token in logs or audit', async () => {
    const { link_token } = await newLink();
    await respond(link_token, { response: 'decline' });
    const evs = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'intake.received'));
    expect(JSON.stringify(evs)).not.toContain(link_token);
  });
});

describe('intake queue (staff)', () => {
  it('moves a request through statuses with attribution and closes it', async () => {
    const { intake_request } = await newLink(t.SEED.homeA2, null);
    const id = intake_request.id;
    const patch = (payload: Record<string, unknown>) =>
      t.app.inject({ method: 'PATCH', url: `/v1/intake-requests/${id}`, headers: staff(), payload });

    const contacted = await patch({ status: 'contacted' });
    expect(contacted.json()).toMatchObject({ status: 'contacted', status_changed_by: t.SEED.staffA.id });
    expect((await patch({ status: 'contacted' })).statusCode).toBe(409);
    expect((await patch({ status: 'received' })).statusCode).toBe(400);
    await patch({ status: 'scheduled_externally', note: 'Booked in their calendar for Tue' });

    const open = await t.app.inject({ method: 'GET', url: '/v1/intake-requests?status=open', headers: staff() });
    expect(open.json().data.some((r: { id: string }) => r.id === id)).toBe(false);

    const [closed] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'intake.closed'), eq(auditEvents.recordId, id)));
    expect(closed).toMatchObject({ actorAccountId: t.SEED.staffA.id, after: { status: 'scheduled_externally' } });
  });

  it("can't see or change another org's requests", async () => {
    const { intake_request } = await newLink();
    const other = t.as(t.SEED.ownerB, t.SEED.orgB);
    for (const req of [
      { method: 'GET' as const, url: `/v1/intake-requests/${intake_request.id}` },
      { method: 'PATCH' as const, url: `/v1/intake-requests/${intake_request.id}`, payload: { status: 'contacted' } },
      { method: 'POST' as const, url: `/v1/intake-requests/${intake_request.id}/revoke-link` },
    ]) {
      const res = await t.app.inject({ ...req, headers: other });
      expect(res.statusCode).toBe(404);
    }
    const list = await t.app.inject({ method: 'GET', url: '/v1/intake-requests', headers: other });
    expect(list.json().data).toEqual([]);
    const cross = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${t.SEED.homeA1}/intake-requests`,
      headers: other,
      payload: {},
    });
    expect(cross.statusCode).toBe(404);
  });

  it('paginates the queue', async () => {
    const p1 = await t.app.inject({ method: 'GET', url: '/v1/intake-requests?limit=2', headers: staff() });
    expect(p1.json().data).toHaveLength(2);
    const p2 = await t.app.inject({
      method: 'GET',
      url: `/v1/intake-requests?limit=100&cursor=${p1.json().next_cursor}`,
      headers: staff(),
    });
    const ids = [...p1.json().data, ...p2.json().data].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
