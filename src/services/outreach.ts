/**
 * Email outreach (PRD §4 step 6, §10). Staff draft a campaign for customers they
 * picked (usually from the due queue), preview who will and won't receive it, then
 * send. Consent and suppression are checked again for each recipient immediately
 * before dispatch. Each message gets its own response link (an intake request) and
 * unsubscribe link. Retrying a send never emails anyone twice.
 *
 * Sends run inside the request for R1 (audience capped at MAX_AUDIENCE). A job queue
 * replaces this with the scheduler work.
 */
import { and, count, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  customers,
  intakeEvents,
  intakeRequests,
  organizations,
  outreachCampaigns,
  outreachMessages,
} from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { Actor, ScopedContext } from './context.js';
import { checkEligibility, recordOptOut, type Purpose } from './consent.js';
import { getOrganization, type OrganizationRow } from './organizations.js';
import { LINK_TTL_DAYS } from './intake.js';
import { ApiError, Errors } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { hashToken, looksLikeToken, newLinkToken } from '../lib/tokens.js';
import { renderEmail, validateTemplate } from '../lib/email-template.js';
import { MailerError, type Mailer } from '../lib/mailer.js';

export const MAX_AUDIENCE = 200;
/** A send that has made no progress for this long is treated as interrupted and may be resumed. */
export const STALE_SEND_MS = 2 * 60_000;

export type CampaignRow = typeof outreachCampaigns.$inferSelect;
export type MessageRow = typeof outreachMessages.$inferSelect;

/** Deployment settings for sending. Anything missing means email isn't set up yet. */
export interface OutreachEnv {
  mailer: Mailer | null;
  /** Platform sending address on a verified domain, e.g. reminders@mail.example.com. */
  fromAddress: string | null;
  /** Front-end origin that serves /r (response) and /unsubscribe pages. */
  appBaseUrl: string | null;
  /** This API's public origin, for the one-click List-Unsubscribe URL. */
  apiBaseUrl: string;
}

export type SkipReason = 'customer_deleted' | 'customer_suppressed' | 'no_contact' | 'opted_out' | 'no_consent';

export interface Results {
  sent: number;
  failed: number;
  suppressed: number;
  queued: number;
}

export function toCampaignDto(c: CampaignRow, results: Results | null = null) {
  return {
    id: c.id,
    name: c.name,
    channel: c.channel,
    purpose: c.purpose,
    service_type: c.serviceType,
    status: c.status,
    subject: c.templateSubject,
    body: c.templateBody,
    template_version: c.templateVersion,
    customer_ids: c.audienceCustomerIds,
    audience_size: c.audienceCustomerIds.length,
    created_by: c.createdBy,
    approved_by: c.approvedBy,
    sent_at: c.sentAt?.toISOString() ?? null,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
    results,
  };
}

const scope = (ctx: ScopedContext, id: string) =>
  and(eq(outreachCampaigns.organizationId, ctx.organizationId), eq(outreachCampaigns.id, id));

// ------------------------------------------------------------------- drafts

export interface CampaignInput {
  name: string;
  channel: 'email' | 'sms';
  purpose: Purpose;
  serviceType: string | null;
  subject: string | null;
  body: string;
  customerIds: string[];
}

async function validateAudience(ctx: ScopedContext, ids: string[]) {
  if (!ids.length) throw Errors.validation({ customer_ids: 'pick at least one customer' });
  if (ids.length > MAX_AUDIENCE) throw Errors.validation({ customer_ids: `at most ${MAX_AUDIENCE} per campaign` });
  if (new Set(ids).size !== ids.length) throw Errors.validation({ customer_ids: 'duplicate customer' });
  const found = await ctx.db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, ctx.organizationId),
        inArray(customers.id, ids),
        sql`${customers.deletedAt} is null`,
      ),
    );
  const ok = new Set(found.map((r) => r.id));
  const missing = ids.filter((i) => !ok.has(i));
  if (missing.length) throw Errors.validation({ customer_ids: `not found: ${missing.join(', ')}` });
}

function validateContent(channel: string, subject: string | null, body: string) {
  if (channel !== 'email') {
    throw new ApiError(400, 'channel_unavailable', 'Only email outreach is available in this release.');
  }
  if (!subject?.trim()) throw Errors.validation({ subject: 'required for email' });
  if (!body.trim()) throw Errors.validation({ body: 'required' });
  const errs = validateTemplate(subject, body);
  if (errs) throw Errors.validation(errs);
}

export async function createCampaign(ctx: ScopedContext, input: CampaignInput): Promise<CampaignRow> {
  validateContent(input.channel, input.subject, input.body);
  await validateAudience(ctx, input.customerIds);
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(outreachCampaigns)
      .values({
        organizationId: ctx.organizationId,
        name: input.name,
        channel: input.channel,
        purpose: input.purpose,
        serviceType: input.serviceType,
        templateSubject: input.subject,
        templateBody: input.body,
        audienceCustomerIds: input.customerIds,
        createdBy: ctx.actor.accountId,
      })
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'outreach.campaign_created',
      recordType: 'outreach_campaign',
      recordId: row!.id,
      requestId: ctx.requestId,
      after: { channel: row!.channel, purpose: row!.purpose, audience_size: input.customerIds.length },
    });
    return row!;
  });
}

const notDraft = (status: string) =>
  new ApiError(409, 'campaign_not_draft', `This campaign is ${status} and can no longer be changed.`);

export async function updateCampaign(
  ctx: ScopedContext,
  id: string,
  patch: Partial<Omit<CampaignInput, 'channel'>>,
): Promise<CampaignRow> {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [c] = await tx.select().from(outreachCampaigns).where(scope(ctx, id)).for('update');
    if (!c) throw Errors.notFound('Campaign');
    if (c.status !== 'draft') throw notDraft(c.status);
    const subject = patch.subject !== undefined ? patch.subject : c.templateSubject;
    const body = patch.body ?? c.templateBody;
    validateContent(c.channel, subject, body);
    if (patch.customerIds) await validateAudience({ ...ctx, db: tx }, patch.customerIds);
    const contentChanged = subject !== c.templateSubject || body !== c.templateBody;
    const [after] = await tx
      .update(outreachCampaigns)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.purpose !== undefined ? { purpose: patch.purpose } : {}),
        ...(patch.serviceType !== undefined ? { serviceType: patch.serviceType } : {}),
        ...(patch.customerIds ? { audienceCustomerIds: patch.customerIds } : {}),
        templateSubject: subject,
        templateBody: body,
        templateVersion: contentChanged ? c.templateVersion + 1 : c.templateVersion,
        updatedAt: new Date(),
      })
      .where(scope(ctx, id))
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'outreach.campaign_updated',
      recordType: 'outreach_campaign',
      recordId: id,
      requestId: ctx.requestId,
      before: { template_version: c.templateVersion, audience_size: c.audienceCustomerIds.length, purpose: c.purpose },
      after: {
        template_version: after!.templateVersion,
        audience_size: after!.audienceCustomerIds.length,
        purpose: after!.purpose,
      },
    });
    return after!;
  });
}

export async function cancelCampaign(ctx: ScopedContext, id: string): Promise<CampaignRow> {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [c] = await tx.select().from(outreachCampaigns).where(scope(ctx, id)).for('update');
    if (!c) throw Errors.notFound('Campaign');
    if (c.status === 'cancelled') return c;
    if (c.status !== 'draft') throw notDraft(c.status);
    const [after] = await tx
      .update(outreachCampaigns)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(scope(ctx, id))
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'outreach.campaign_cancelled',
      recordType: 'outreach_campaign',
      recordId: id,
      requestId: ctx.requestId,
    });
    return after!;
  });
}

async function resultsFor(db: Db, orgId: string, campaignIds: string[]) {
  const out = new Map<string, Results>();
  if (!campaignIds.length) return out;
  const rows = await db
    .select({ campaignId: outreachMessages.campaignId, status: outreachMessages.status, n: count() })
    .from(outreachMessages)
    .where(and(eq(outreachMessages.organizationId, orgId), inArray(outreachMessages.campaignId, campaignIds)))
    .groupBy(outreachMessages.campaignId, outreachMessages.status);
  for (const r of rows) {
    const cur = out.get(r.campaignId) ?? { sent: 0, failed: 0, suppressed: 0, queued: 0 };
    // "delivered" comes from provider webhooks later; it still counts as sent.
    const key = r.status === 'delivered' ? 'sent' : r.status;
    cur[key] += r.n;
    out.set(r.campaignId, cur);
  }
  return out;
}

export async function getCampaign(ctx: ScopedContext, id: string) {
  const [c] = await ctx.db.select().from(outreachCampaigns).where(scope(ctx, id));
  if (!c) return null;
  const results = c.status === 'draft' || c.status === 'cancelled' ? null : await resultsFor(ctx.db, ctx.organizationId, [id]);
  return { campaign: c, results: results?.get(id) ?? (results ? { sent: 0, failed: 0, suppressed: 0, queued: 0 } : null) };
}

export async function listCampaigns(ctx: ScopedContext, opts: { limit: number; cursor?: string }) {
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  const before = cur
    ? or(
        lt(outreachCampaigns.createdAt, new Date(cur.t)),
        and(eq(outreachCampaigns.createdAt, new Date(cur.t)), lt(outreachCampaigns.id, cur.id)),
      )
    : undefined;
  const rows = await ctx.db
    .select()
    .from(outreachCampaigns)
    .where(and(eq(outreachCampaigns.organizationId, ctx.organizationId), before))
    .orderBy(desc(outreachCampaigns.createdAt), desc(outreachCampaigns.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const results = await resultsFor(
    ctx.db,
    ctx.organizationId,
    page.filter((c) => c.status === 'sending' || c.status === 'sent').map((c) => c.id),
  );
  const last = page[page.length - 1];
  return {
    data: page.map((c) => ({ campaign: c, results: results.get(c.id) ?? null })),
    nextCursor: rows.length > opts.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

// ------------------------------------------------------------ preview and send

type CustomerRow = typeof customers.$inferSelect;

async function loadAudience(db: Db, orgId: string, ids: string[]) {
  if (!ids.length) return new Map<string, CustomerRow>();
  const rows = await db
    .select()
    .from(customers)
    .where(and(eq(customers.organizationId, orgId), inArray(customers.id, ids)));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Will this customer get this campaign right now, and under which consent record? */
async function assess(
  db: Db,
  c: CampaignRow,
  customer: CustomerRow | undefined,
): Promise<{ send: true; consentRecordId: string | null } | { send: false; reason: SkipReason }> {
  if (!customer || customer.deletedAt) return { send: false, reason: 'customer_deleted' };
  if (customer.suppressed) return { send: false, reason: 'customer_suppressed' };
  const e = await checkEligibility(db, c.organizationId, 'email', customer.email, c.purpose);
  return e.eligible ? { send: true, consentRecordId: e.consentRecordId } : { send: false, reason: e.reason };
}

export function senderOf(org: OrganizationRow, env: OutreachEnv) {
  const problems: ('email_not_configured' | 'mailing_address_missing')[] = [];
  if (!env.mailer || !env.fromAddress || !env.appBaseUrl) problems.push('email_not_configured');
  if (!org.mailingAddress?.trim()) problems.push('mailing_address_missing');
  return {
    from_name: org.messageFromName || org.name,
    from_email: env.fromAddress,
    reply_to: org.replyToEmail,
    mailing_address: org.mailingAddress,
    ready: problems.length === 0,
    problems,
  };
}

const EXAMPLE_TOKEN = 'example-link-shown-in-preview-only';

export async function previewCampaign(ctx: ScopedContext, id: string, env: OutreachEnv) {
  const [c] = await ctx.db.select().from(outreachCampaigns).where(scope(ctx, id));
  if (!c) throw Errors.notFound('Campaign');
  const org = await getOrganization(ctx);
  const audience = await loadAudience(ctx.db, ctx.organizationId, c.audienceCustomerIds);
  const recipients = [];
  let firstSendable: CustomerRow | null = null;
  for (const cid of c.audienceCustomerIds) {
    const cust = audience.get(cid);
    const a = await assess(ctx.db, c, cust);
    if (a.send && !firstSendable) firstSendable = cust!;
    recipients.push({
      customer_id: cid,
      customer_name: cust && !cust.deletedAt ? cust.displayName : null,
      email: cust && !cust.deletedAt ? cust.email : null,
      will_send: a.send,
      reason: a.send ? null : a.reason,
    });
  }
  const sender = senderOf(org, env);
  const base = env.appBaseUrl ?? 'https://app.example';
  const sample = firstSendable
    ? {
        to: firstSendable.email!,
        ...renderEmail({
          subject: c.templateSubject ?? '',
          body: c.templateBody,
          vars: { customer_name: firstSendable.displayName, business_name: sender.from_name, service_type: c.serviceType },
          responseUrl: `${base}/r#${EXAMPLE_TOKEN}`,
          unsubscribeUrl: `${base}/unsubscribe#${EXAMPLE_TOKEN}`,
          mailingAddress: org.mailingAddress ?? '[your business mailing address]',
          recipient: firstSendable.email!,
        }),
      }
    : null;
  const willSend = recipients.filter((r) => r.will_send).length;
  return {
    recipients,
    summary: { total: recipients.length, will_send: willSend, skipped: recipients.length - willSend },
    sample,
    sender,
  };
}

const notConfigured = () =>
  new ApiError(503, 'email_not_configured', 'Email sending is not set up for this environment yet.');

/**
 * Approve and send. Safe to call again: a sent campaign returns its results, a send
 * in progress returns 409, and an interrupted send resumes with only the customers
 * who have no message yet.
 */
export async function sendCampaign(ctx: ScopedContext, id: string, env: OutreachEnv) {
  if (!env.mailer || !env.fromAddress || !env.appBaseUrl) throw notConfigured();
  const org = await getOrganization(ctx);
  const sender = senderOf(org, env);

  const claim = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [c] = await tx.select().from(outreachCampaigns).where(scope(ctx, id)).for('update');
    if (!c) throw Errors.notFound('Campaign');
    if (c.status === 'cancelled') throw new ApiError(409, 'campaign_cancelled', 'This campaign was cancelled.');
    if (c.status === 'sent') return { c, run: false };
    if (c.status === 'sending' && Date.now() - c.updatedAt.getTime() < STALE_SEND_MS) {
      throw new ApiError(409, 'send_in_progress', 'This campaign is already being sent.');
    }
    if (!sender.ready) {
      throw new ApiError(
        409,
        'sender_incomplete',
        'Add your business mailing address in Settings before sending email.',
        { problems: sender.problems },
      );
    }
    const firstRun = c.status === 'draft';
    const [after] = await tx
      .update(outreachCampaigns)
      .set({ status: 'sending', updatedAt: new Date(), ...(firstRun ? { approvedBy: ctx.actor.accountId } : {}) })
      .where(scope(ctx, id))
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: firstRun ? 'outreach.campaign_approved' : 'outreach.campaign_resumed',
      recordType: 'outreach_campaign',
      recordId: id,
      requestId: ctx.requestId,
      after: { template_version: c.templateVersion, audience_size: c.audienceCustomerIds.length, purpose: c.purpose },
    });
    return { c: after!, run: true };
  });
  if (!claim.run) return getCampaign(ctx, id).then((r) => r!);
  const c = claim.c;

  // A previous run that died mid-send may have left messages whose outcome is unknown.
  // Don't resend them (the customer may already have it); record them as failed.
  await ctx.db
    .update(outreachMessages)
    .set({ status: 'failed', providerResult: { error: 'dispatch_interrupted' }, updatedAt: new Date() })
    .where(
      and(
        eq(outreachMessages.organizationId, ctx.organizationId),
        eq(outreachMessages.campaignId, id),
        eq(outreachMessages.status, 'queued'),
      ),
    );
  const done = new Set(
    (
      await ctx.db
        .select({ customerId: outreachMessages.customerId })
        .from(outreachMessages)
        .where(and(eq(outreachMessages.organizationId, ctx.organizationId), eq(outreachMessages.campaignId, id)))
    ).map((r) => r.customerId),
  );
  const audience = await loadAudience(ctx.db, ctx.organizationId, c.audienceCustomerIds);
  const senderIdentity = `${sender.from_name} <${env.fromAddress}>`;

  for (const customerId of c.audienceCustomerIds) {
    if (done.has(customerId)) continue;
    const outcome = await sendOne(ctx, c, audience.get(customerId), customerId, { env, org, senderIdentity });
    if (outcome === 'abort') {
      throw new ApiError(
        502,
        'email_provider_error',
        'The email provider refused our credentials. Nothing more was sent; try again once email is fixed.',
      );
    }
    await ctx.db.update(outreachCampaigns).set({ updatedAt: new Date() }).where(scope(ctx, id));
  }

  const results = (await resultsFor(ctx.db, ctx.organizationId, [id])).get(id) ?? {
    sent: 0,
    failed: 0,
    suppressed: 0,
    queued: 0,
  };
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx
      .update(outreachCampaigns)
      .set({ status: 'sent', sentAt: new Date(), updatedAt: new Date() })
      .where(scope(ctx, id));
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'outreach.campaign_sent',
      recordType: 'outreach_campaign',
      recordId: id,
      requestId: ctx.requestId,
      after: { ...results },
    });
  });
  return getCampaign(ctx, id).then((r) => r!);
}

async function sendOne(
  ctx: ScopedContext,
  c: CampaignRow,
  customer: CustomerRow | undefined,
  customerId: string,
  s: { env: OutreachEnv; org: OrganizationRow; senderIdentity: string },
): Promise<'sent' | 'failed' | 'suppressed' | 'skipped' | 'abort'> {
  const base = {
    organizationId: ctx.organizationId,
    campaignId: c.id,
    customerId,
    channel: 'email' as const,
    senderIdentity: s.senderIdentity,
    templateVersion: c.templateVersion,
    idempotencyKey: `campaign:${c.id}:${customerId}`,
  };
  // Checked now, immediately before dispatch, not when the campaign was drafted.
  const a = await assess(ctx.db, c, customer);
  if (!a.send) {
    const ins = await ctx.db
      .insert(outreachMessages)
      .values({ ...base, recipient: customer?.email ?? '', status: 'suppressed', suppressionReason: a.reason })
      .onConflictDoNothing()
      .returning({ id: outreachMessages.id });
    return ins.length ? 'suppressed' : 'skipped';
  }

  const recipient = customer!.email!;
  const responseToken = newLinkToken();
  const unsubscribeToken = newLinkToken();
  const created = await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [msg] = await tx
      .insert(outreachMessages)
      .values({
        ...base,
        recipient,
        consentRecordId: a.consentRecordId,
        status: 'queued',
        unsubscribeTokenHash: hashToken(unsubscribeToken),
      })
      .onConflictDoNothing()
      .returning();
    if (!msg) return null; // another run already handled this customer
    const [req] = await tx
      .insert(intakeRequests)
      .values({
        organizationId: ctx.organizationId,
        customerId,
        outreachMessageId: msg.id,
        serviceType: c.serviceType,
        createdBy: ctx.actor.accountId,
        linkTokenHash: hashToken(responseToken),
        linkExpiresAt: new Date(Date.now() + LINK_TTL_DAYS * 86_400_000),
      })
      .returning({ id: intakeRequests.id });
    await tx.insert(intakeEvents).values({
      organizationId: ctx.organizationId,
      intakeRequestId: req!.id,
      fromStatus: null,
      toStatus: 'awaiting_response',
      actorType: ctx.actor.type,
      actorAccountId: ctx.actor.accountId,
      note: 'sent by email',
    });
    return { msg, intakeId: req!.id };
  });
  if (!created) return 'skipped';

  const appBase = s.env.appBaseUrl!;
  const email = renderEmail({
    subject: c.templateSubject ?? '',
    body: c.templateBody,
    vars: {
      customer_name: customer!.displayName,
      business_name: s.org.messageFromName || s.org.name,
      service_type: c.serviceType,
    },
    responseUrl: `${appBase}/r#${responseToken}`,
    unsubscribeUrl: `${appBase}/unsubscribe#${unsubscribeToken}`,
    mailingAddress: s.org.mailingAddress!,
    recipient,
  });
  const oneClick = `${s.env.apiBaseUrl}/v1/public/unsubscribe/${unsubscribeToken}`;

  let res: Awaited<ReturnType<Mailer['send']>>;
  try {
    res = await s.env.mailer!.send({
      to: recipient,
      fromEmail: s.env.fromAddress!,
      fromName: s.org.messageFromName || s.org.name,
      replyTo: s.org.replyToEmail,
      subject: email.subject,
      text: email.text,
      html: email.html,
      headers: { 'List-Unsubscribe': `<${oneClick}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: { message_id: created.msg.id, organization_id: ctx.organizationId },
    });
  } catch (err) {
    const e = err instanceof MailerError ? err : new MailerError('internal', 'unexpected mailer error');
    await ctx.db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx
        .update(outreachMessages)
        .set({
          status: 'failed',
          providerResult: { provider: s.env.mailer!.provider, code: e.code, detail: e.detail },
          updatedAt: new Date(),
        })
        .where(eq(outreachMessages.id, created.msg.id));
      // The customer never got this link, so it must not sit in the intake queue.
      await tx.delete(intakeEvents).where(eq(intakeEvents.intakeRequestId, created.intakeId));
      await tx.delete(intakeRequests).where(eq(intakeRequests.id, created.intakeId));
      await recordAudit(tx, {
        actor: ctx.actor,
        organizationId: ctx.organizationId,
        action: 'outreach.failed',
        outcome: 'error',
        recordType: 'outreach_message',
        recordId: created.msg.id,
        requestId: ctx.requestId,
        metadata: { campaign_id: c.id, code: e.code },
      });
    });
    return e.code === 'provider_auth' ? 'abort' : 'failed';
  }

  // Accepted by the provider. If recording this fails, the message stays "queued" and a
  // resumed send marks it interrupted rather than emailing the customer again.
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const now = new Date();
    await tx
      .update(outreachMessages)
      .set({
        status: 'sent',
        providerMessageId: res.providerMessageId,
        providerResult: { provider: s.env.mailer!.provider, accepted: true },
        sentAt: now,
        updatedAt: now,
      })
      .where(eq(outreachMessages.id, created.msg.id));
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'outreach.sent',
      recordType: 'outreach_message',
      recordId: created.msg.id,
      requestId: ctx.requestId,
      after: {
        campaign_id: c.id,
        customer_id: customerId,
        consent_record_id: a.consentRecordId,
        template_version: c.templateVersion,
        intake_request_id: created.intakeId,
      },
    });
  });
  return 'sent';
}

export async function listCampaignMessages(ctx: ScopedContext, id: string) {
  const [c] = await ctx.db.select({ id: outreachCampaigns.id }).from(outreachCampaigns).where(scope(ctx, id));
  if (!c) return null;
  return ctx.db
    .select({
      m: outreachMessages,
      customerName: customers.displayName,
      intakeRequestId: intakeRequests.id,
    })
    .from(outreachMessages)
    .innerJoin(
      customers,
      and(eq(customers.id, outreachMessages.customerId), eq(customers.organizationId, outreachMessages.organizationId)),
    )
    .leftJoin(
      intakeRequests,
      and(
        eq(intakeRequests.outreachMessageId, outreachMessages.id),
        eq(intakeRequests.organizationId, outreachMessages.organizationId),
      ),
    )
    .where(and(eq(outreachMessages.organizationId, ctx.organizationId), eq(outreachMessages.campaignId, id)))
    .orderBy(outreachMessages.createdAt);
}

// ---------------------------------------------------------------- unsubscribe

const linkActor: Actor = { type: 'customer_link', accountId: null, label: 'unsubscribe link' };

const invalidLink = () =>
  new ApiError(404, 'link_invalid', 'This link is invalid. Please contact the business directly.');

/**
 * Opt the recipient of a message out of all future email from that business. Works
 * for as long as the message exists (unsubscribe links don't expire). Idempotent.
 */
export async function unsubscribeByToken(db: Db, token: string, source: string, requestId: string) {
  if (!looksLikeToken(token)) throw invalidLink();
  const [row] = await db
    .select({ m: outreachMessages, businessName: organizations.name, fromName: organizations.messageFromName })
    .from(outreachMessages)
    .innerJoin(organizations, eq(organizations.id, outreachMessages.organizationId))
    .where(eq(outreachMessages.unsubscribeTokenHash, hashToken(token)))
    .limit(1);
  if (!row) throw invalidLink();
  const m = row.m;
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const e = await checkEligibility(tx, m.organizationId, 'email', m.recipient, 'service_reminders');
    if (!e.eligible && e.reason === 'opted_out') return; // already unsubscribed
    await recordOptOut(tx, {
      organizationId: m.organizationId,
      customerId: m.customerId,
      channel: 'email',
      contactValue: m.recipient,
      source,
    });
    await recordAudit(tx, {
      actor: linkActor,
      organizationId: m.organizationId,
      action: 'contact.opted_out',
      recordType: 'outreach_message',
      recordId: m.id,
      requestId,
      metadata: { channel: 'email', source },
    });
  });
  return { business_name: row.fromName || row.businessName };
}
