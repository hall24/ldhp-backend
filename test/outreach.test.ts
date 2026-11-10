import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { auditEvents, intakeRequests, outreachCampaigns, outreachMessages } from '../src/db/schema.js';
import { checkEligibility } from '../src/services/consent.js';
import { MemoryMailer, type OutgoingEmail } from '../src/lib/mailer.js';
import { renderEmail, validateTemplate } from '../src/lib/email-template.js';
import { fakeVerifier, setup } from './helpers/app.js';

const mailer = new MemoryMailer();
let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup({
    email: { mailer, fromAddress: 'reminders@mail.example.test', appBaseUrl: 'https://app.example.test/' },
  });
});
afterAll(async () => t.teardown());

const staff = () => t.as(t.SEED.staffA, t.SEED.orgA);
const owner = () => t.as(t.SEED.ownerA, t.SEED.orgA);

async function customer(name: string, email: string | null) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/customers',
    headers: staff(),
    payload: { display_name: name, email },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function draft(customerIds: string[], extra: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/campaigns',
    headers: staff(),
    payload: {
      name: 'Spring gutters',
      service_type: 'gutter_cleaning',
      subject: 'Time for {{service_type}}, {{customer_name}}?',
      body: 'Hi {{customer_name}},\n\nIt has been a year since your last {{service_type}}. Book here: {{response_link}}',
      customer_ids: customerIds,
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; template_version: number; status: string };
}

const send = (id: string, headers = staff()) =>
  t.app.inject({ method: 'POST', url: `/v1/campaigns/${id}/send`, headers });
const preview = (id: string) => t.app.inject({ method: 'GET', url: `/v1/campaigns/${id}/preview`, headers: staff() });

const setMailingAddress = (value: string | null) =>
  t.app.inject({
    method: 'PATCH',
    url: '/v1/organization',
    headers: owner(),
    payload: { mailing_address: value, reply_to_email: 'office@gutters.example.test' },
  });

const tokenFrom = (url: string) => url.split('#')[1]!;
const linksIn = (e: OutgoingEmail) => ({
  response: e.text.match(/https:\/\/app\.example\.test\/r#[A-Za-z0-9_-]{43}/)![0],
  unsubscribe: e.text.match(/https:\/\/app\.example\.test\/unsubscribe#[A-Za-z0-9_-]{43}/)![0],
});

describe('templates', () => {
  it('rejects unknown placeholders and links in the subject', () => {
    expect(validateTemplate('Hi {{first_name}}', 'x')).toEqual({ subject: expect.stringContaining('first_name') });
    expect(validateTemplate('{{response_link}}', 'x')).toEqual({ subject: expect.any(String) });
    expect(validateTemplate('ok', '{{ customer_name }} {{response_link}}')).toBeNull();
  });

  it('escapes customer data in HTML and always adds the footer and a reply link', () => {
    const out = renderEmail({
      subject: 'Hi {{customer_name}}',
      body: 'Hello {{customer_name}}',
      vars: { customer_name: '<script>x</script>', business_name: 'A&B Gutters', service_type: 'gutter_cleaning' },
      responseUrl: 'https://app/r#tok',
      unsubscribeUrl: 'https://app/unsubscribe#u',
      mailingAddress: '1 Main St\nTown, NJ',
      recipient: 'c@example.test',
    });
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).toContain('A&amp;B Gutters');
    expect(out.text).toContain('https://app/r#tok');
    expect(out.text).toContain('Unsubscribe: https://app/unsubscribe#u');
    expect(out.text).toContain('1 Main St');
  });
});

describe('drafting', () => {
  it('rejects SMS, unknown placeholders and customers from another business', async () => {
    const base = { name: 'x', subject: 's', body: 'b', customer_ids: [t.SEED.homeA1] };
    const cases = [
      { ...base, channel: 'sms' },
      { ...base, body: 'Hi {{first_name}}' },
      { ...base, customer_ids: [t.SEED.homeB1] },
      { ...base, customer_ids: [t.SEED.homeA1, t.SEED.homeA1] },
    ];
    for (const payload of cases) {
      const res = await t.app.inject({ method: 'POST', url: '/v1/campaigns', headers: staff(), payload });
      expect(res.statusCode).toBe(400);
    }
  });

  it('bumps the template version when the wording changes, and hides drafts from other businesses', async () => {
    const c = await draft([t.SEED.homeA1]);
    const edit = await t.app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${c.id}`,
      headers: staff(),
      payload: { body: 'New wording {{response_link}}' },
    });
    expect(edit.json().template_version).toBe(c.template_version + 1);
    const rename = await t.app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${c.id}`,
      headers: staff(),
      payload: { name: 'Renamed' },
    });
    expect(rename.json().template_version).toBe(c.template_version + 1);

    const other = t.as(t.SEED.ownerB, t.SEED.orgB);
    for (const req of [
      { method: 'GET' as const, url: `/v1/campaigns/${c.id}` },
      { method: 'GET' as const, url: `/v1/campaigns/${c.id}/preview` },
      { method: 'POST' as const, url: `/v1/campaigns/${c.id}/send` },
      { method: 'GET' as const, url: `/v1/campaigns/${c.id}/messages` },
    ]) {
      expect((await t.app.inject({ ...req, headers: other })).statusCode).toBe(404);
    }
    expect((await t.app.inject({ method: 'GET', url: '/v1/campaigns', headers: other })).json().data).toEqual([]);
  });
});

describe('preview and send', () => {
  it('previews who gets it and why others are skipped', async () => {
    const suppressed = await customer('Paused Home', 'paused@example.test');
    await t.app.inject({
      method: 'PATCH',
      url: `/v1/customers/${suppressed}`,
      headers: staff(),
      payload: { suppressed: true },
    });
    const c = await draft([t.SEED.homeA1, t.SEED.homeA2, suppressed]);
    const res = await preview(c.id);
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.summary).toEqual({ total: 3, will_send: 1, skipped: 2 });
    expect(p.recipients.map((r: { reason: string | null }) => r.reason)).toEqual([
      null,
      'no_contact',
      'customer_suppressed',
    ]);
    expect(p.sample.subject).toBe('Time for gutter cleaning, Test Home One?');
    expect(p.sample.text).toContain('example-link-shown-in-preview-only');
    expect(p.sender).toMatchObject({ from_name: 'Test Gutter Co', ready: false, problems: ['mailing_address_missing'] });

    const marketing = await draft([t.SEED.homeA1], { purpose: 'marketing' });
    expect((await preview(marketing.id)).json().recipients[0].reason).toBe('no_consent');
  });

  it('refuses to send without a mailing address, or when email is not set up', async () => {
    const c = await draft([t.SEED.homeA1]);
    const res = await send(c.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('sender_incomplete');

    const bare = await buildApp({ db: t.db, verifier: fakeVerifier });
    const off = await bare.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/send`, headers: staff() });
    expect(off.statusCode).toBe(503);
    expect(off.json().error.code).toBe('email_not_configured');
    await bare.close();
    expect(mailer.sent).toHaveLength(0);
  });

  it('sends once per customer, checks opt-outs at send time, and links each email to an intake request', async () => {
    expect((await setMailingAddress('100 Gutter Ln\nExampleville, NJ 00001')).statusCode).toBe(200);
    const a = await customer('Alpha Home', 'alpha@example.test');
    const b = await customer('Bravo Home', 'Bravo@Example.test');
    const c = await draft([a, b, t.SEED.homeA2]);
    expect((await preview(c.id)).json().summary.will_send).toBe(2);

    // Bravo opts out after the preview: the send must still honour it.
    const consent = await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${b}/consents`,
      headers: staff(),
      payload: { channel: 'email', purpose: 'service_reminders', source: 'web_form' },
    });
    await t.app.inject({
      method: 'POST',
      url: `/v1/customers/${b}/consents/${consent.json().id}/withdraw`,
      headers: staff(),
      payload: { source: 'phone_call' },
    });

    const before = mailer.sent.length;
    const res = await send(c.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'sent',
      approved_by: t.SEED.staffA.id,
      results: { sent: 1, suppressed: 2, failed: 0, queued: 0 },
    });
    const mails = mailer.sent.slice(before);
    expect(mails.map((m) => m.to)).toEqual(['alpha@example.test']);
    const mail = mails[0]!;
    expect(mail).toMatchObject({
      fromEmail: 'reminders@mail.example.test',
      fromName: 'Test Gutter Co',
      replyTo: 'office@gutters.example.test',
      subject: 'Time for gutter cleaning, Alpha Home?',
    });
    expect(mail.text).toContain('100 Gutter Ln');
    expect(mail.headers!['List-Unsubscribe']).toMatch(
      /^<https:\/\/api\.example\.test\/v1\/public\/unsubscribe\/[A-Za-z0-9_-]{43}>$/,
    );
    expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Sending again (double click, retry) sends nothing more.
    const again = await send(c.id);
    expect(again.statusCode).toBe(200);
    expect(mailer.sent.length).toBe(before + 1);

    const msgs = (await t.app.inject({ method: 'GET', url: `/v1/campaigns/${c.id}/messages`, headers: staff() })).json()
      .data;
    const byName = Object.fromEntries(msgs.map((m: { customer_name: string }) => [m.customer_name, m]));
    expect(byName['Alpha Home']).toMatchObject({ status: 'sent', template_version: 1, intake_request_id: expect.any(String) });
    expect(byName['Bravo Home']).toMatchObject({ status: 'suppressed', suppression_reason: 'opted_out', intake_request_id: null });
    expect(byName['Test Home Two']).toMatchObject({ status: 'suppressed', suppression_reason: 'no_contact' });

    // The response link in the email opens the right request for the customer.
    const view = await t.app.inject({
      method: 'POST',
      url: '/v1/public/intake/view',
      payload: { token: tokenFrom(linksIn(mail).response) },
    });
    expect(view.json()).toMatchObject({ business_name: 'Test Gutter Co', service_type: 'gutter_cleaning' });
    const [ir] = await t.db.select().from(intakeRequests).where(eq(intakeRequests.id, byName['Alpha Home'].intake_request_id));
    expect(ir).toMatchObject({ status: 'awaiting_response', serviceType: 'gutter_cleaning' });

    // No link tokens in the database or audit trail.
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.action, 'outreach.sent'));
    const rows = await t.db.select().from(outreachMessages).where(eq(outreachMessages.campaignId, c.id));
    for (const tok of [tokenFrom(linksIn(mail).response), tokenFrom(linksIn(mail).unsubscribe)]) {
      expect(JSON.stringify(audit)).not.toContain(tok);
      expect(JSON.stringify(rows)).not.toContain(tok);
    }

    const edit = await t.app.inject({ method: 'PATCH', url: `/v1/campaigns/${c.id}`, headers: staff(), payload: { name: 'x' } });
    expect(edit.statusCode).toBe(409);
  });

  it('records provider failures without leaving a dead link in the intake queue', async () => {
    const ok = await customer('Good Address', 'good@example.test');
    const bad = await customer('Bad Address', 'bounce@example.test');
    mailer.failFor.add('bounce@example.test');
    const c = await draft([ok, bad]);
    const res = await send(c.id);
    mailer.failFor.clear();
    expect(res.json().results).toMatchObject({ sent: 1, failed: 1 });
    const [failed] = await t.db
      .select()
      .from(outreachMessages)
      .where(and(eq(outreachMessages.campaignId, c.id), eq(outreachMessages.customerId, bad)));
    expect(failed).toMatchObject({ status: 'failed' });
    const leftover = await t.db.select().from(intakeRequests).where(eq(intakeRequests.outreachMessageId, failed!.id));
    expect(leftover).toEqual([]);
  });

  it('resumes an interrupted send without re-emailing anyone whose outcome is unknown', async () => {
    const x = await customer('Xray Home', 'xray@example.test');
    const y = await customer('Yankee Home', 'yankee@example.test');
    const c = await draft([x, y]);
    // Simulate a crash: campaign stuck in "sending", one message queued with unknown outcome.
    await t.db
      .update(outreachCampaigns)
      .set({ status: 'sending', updatedAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(outreachCampaigns.id, c.id));
    await t.db.insert(outreachMessages).values({
      organizationId: t.SEED.orgA,
      campaignId: c.id,
      customerId: x,
      channel: 'email',
      recipient: 'xray@example.test',
      senderIdentity: 'Test Gutter Co <reminders@mail.example.test>',
      templateVersion: 1,
      idempotencyKey: `campaign:${c.id}:${x}`,
    });
    const before = mailer.sent.length;
    const res = await send(c.id);
    expect(res.json()).toMatchObject({ status: 'sent', results: { sent: 1, failed: 1 } });
    expect(mailer.sent.slice(before).map((m) => m.to)).toEqual(['yankee@example.test']);

    // A send that is still running (recent activity) is not started twice.
    const z = await draft([x]);
    await t.db.update(outreachCampaigns).set({ status: 'sending', updatedAt: new Date() }).where(eq(outreachCampaigns.id, z.id));
    const busy = await send(z.id);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('send_in_progress');
  });

  it('cannot send a cancelled campaign', async () => {
    const c = await draft([t.SEED.homeA1]);
    const cancel = await t.app.inject({ method: 'POST', url: `/v1/campaigns/${c.id}/cancel`, headers: staff() });
    expect(cancel.json().status).toBe('cancelled');
    expect((await send(c.id)).statusCode).toBe(409);
  });
});

describe('unsubscribe', () => {
  it('stops future email from the business, from the footer link or one-click', async () => {
    const u = await customer('Uniform Home', 'uniform@example.test');
    const v = await customer('Victor Home', 'victor@example.test');
    const c = await draft([u, v]);
    const before = mailer.sent.length;
    await send(c.id);
    const [mu, mv] = mailer.sent.slice(before);

    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/public/unsubscribe',
      payload: { token: tokenFrom(linksIn(mu!).unsubscribe) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ business_name: 'Test Gutter Co' });
    expect(await checkEligibility(t.db, t.SEED.orgA, 'email', 'uniform@example.test', 'service_reminders')).toEqual({
      eligible: false,
      reason: 'opted_out',
    });
    // Repeating it is harmless and records nothing new.
    await t.app.inject({ method: 'POST', url: '/v1/public/unsubscribe', payload: { token: tokenFrom(linksIn(mu!).unsubscribe) } });
    const optOuts = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'contact.opted_out'), eq(auditEvents.organizationId, t.SEED.orgA)));
    expect(optOuts.filter((e) => e.actorType === 'customer_link')).toHaveLength(1);

    const oneClickUrl = mv!.headers!['List-Unsubscribe']!.slice(1, -1).replace('https://api.example.test', '');
    const oneClick = await t.app.inject({
      method: 'POST',
      url: oneClickUrl,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(oneClick.statusCode).toBe(200);
    expect(await checkEligibility(t.db, t.SEED.orgA, 'email', 'victor@example.test', 'service_reminders')).toMatchObject({
      reason: 'opted_out',
    });

    // The next campaign skips both.
    const next = await draft([u, v]);
    expect((await preview(next.id)).json().summary.will_send).toBe(0);

    for (const token of ['nope', 'A'.repeat(43)]) {
      const r = await t.app.inject({ method: 'POST', url: '/v1/public/unsubscribe', payload: { token } });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('link_invalid');
    }
  });
});

describe('SendGrid adapter', () => {
  it('sends the expected request and maps errors without leaking the key', async () => {
    const { SendGridMailer } = await import('../src/lib/mailer.js');
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = new SendGridMailer('SG.secret', (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 202, headers: { 'x-message-id': 'abc' } });
    }) as unknown as typeof fetch);
    const res = await ok.send({
      to: 'c@example.test',
      fromEmail: 'r@mail.example.test',
      fromName: 'Biz',
      subject: 's',
      text: 't',
      html: '<p>t</p>',
      headers: { 'List-Unsubscribe': '<https://x>' },
      tags: { message_id: 'm1' },
    });
    expect(res.providerMessageId).toBe('abc');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(calls[0]!.url).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(body.tracking_settings.click_tracking.enable).toBe(false);
    expect(body.custom_args).toEqual({ message_id: 'm1' });
    expect(body.headers['List-Unsubscribe']).toBe('<https://x>');

    const denied = new SendGridMailer('SG.secret', (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'bad key' }] }), { status: 401 })) as unknown as typeof fetch);
    const err = await denied.send({ to: 'a', fromEmail: 'b', fromName: 'c', subject: 'd', text: 'e', html: 'f' }).catch((e) => e);
    expect(err.code).toBe('provider_auth');
    expect(String(err.message)).not.toContain('SG.secret');
  });
});
