/**
 * Contact permissions (PRD §4 step 5, §6.5, §10). A consent record is scoped to one
 * contact value + channel + purpose for one business (the owning org). Withdrawal is
 * kept as a suppression state and never deleted.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { consentRecords } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { ScopedContext } from './context.js';
import { getCustomer } from './customers.js';
import { Errors } from '../lib/errors.js';

export type Channel = 'email' | 'sms';
export type Purpose = 'service_reminders' | 'marketing';
export type ConsentRow = typeof consentRecords.$inferSelect;

/** Contact values are compared normalized, so "A@X.com " and "a@x.com" are the same person. */
export function normalizeContact(channel: Channel, value: string): string {
  const v = value.trim();
  return channel === 'email' ? v.toLowerCase() : v.replace(/[^\d+]/g, '');
}

export function toConsentDto(c: ConsentRow) {
  return {
    id: c.id,
    customer_id: c.customerId,
    channel: c.channel,
    contact_value: c.contactValue,
    purpose: c.purpose,
    source: c.source,
    granted_at: c.grantedAt.toISOString(),
    withdrawn_at: c.withdrawnAt?.toISOString() ?? null,
    withdrawal_source: c.withdrawalSource,
    status: c.withdrawnAt ? ('withdrawn' as const) : ('active' as const),
    created_at: c.createdAt.toISOString(),
  };
}

export async function listConsents(ctx: ScopedContext, customerId: string): Promise<ConsentRow[] | null> {
  if (!(await getCustomer(ctx, customerId))) return null;
  return ctx.db
    .select()
    .from(consentRecords)
    .where(and(eq(consentRecords.organizationId, ctx.organizationId), eq(consentRecords.customerId, customerId)))
    .orderBy(desc(consentRecords.createdAt));
}

export interface ConsentInput {
  channel: Channel;
  contactValue?: string | null;
  purpose: Purpose;
  source: string;
  evidence?: unknown;
  grantedAt?: Date;
}

/**
 * Record a permission to contact. If `contactValue` is omitted it defaults to the
 * customer's email or phone for that channel.
 */
export async function recordConsent(ctx: ScopedContext, customerId: string, input: ConsentInput) {
  const customer = await getCustomer(ctx, customerId);
  if (!customer) throw Errors.notFound('Customer');
  const raw = input.contactValue ?? (input.channel === 'email' ? customer.email : customer.phone);
  if (!raw) throw Errors.validation({ contact_value: `customer has no ${input.channel} on file` });
  const contactValue = normalizeContact(input.channel, raw);
  if (input.grantedAt && input.grantedAt.getTime() > Date.now() + 60_000) {
    throw Errors.validation({ granted_at: 'cannot be in the future' });
  }
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(consentRecords)
      .values({
        organizationId: ctx.organizationId,
        customerId,
        channel: input.channel,
        contactValue,
        purpose: input.purpose,
        source: input.source,
        evidence: input.evidence ?? null,
        grantedAt: input.grantedAt ?? new Date(),
        recordedBy: ctx.actor.accountId,
      })
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'consent.recorded',
      recordType: 'consent_record',
      recordId: row!.id,
      requestId: ctx.requestId,
      after: { channel: row!.channel, purpose: row!.purpose, source: row!.source, customer_id: customerId },
    });
    return row!;
  });
}

/** Withdraw (opt out). Idempotent: withdrawing twice keeps the first withdrawal time. */
export async function withdrawConsent(
  ctx: ScopedContext,
  customerId: string,
  consentId: string,
  source: string,
): Promise<ConsentRow> {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .select()
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.organizationId, ctx.organizationId),
          eq(consentRecords.customerId, customerId),
          eq(consentRecords.id, consentId),
        ),
      )
      .for('update');
    if (!row) throw Errors.notFound('Consent record');
    if (row.withdrawnAt) return row;
    const [after] = await tx
      .update(consentRecords)
      .set({ withdrawnAt: new Date(), withdrawalSource: source })
      .where(eq(consentRecords.id, consentId))
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'contact.opted_out',
      recordType: 'consent_record',
      recordId: consentId,
      requestId: ctx.requestId,
      before: { status: 'active' },
      after: { status: 'withdrawn', withdrawal_source: source },
    });
    return after!;
  });
}

export type Eligibility =
  | { eligible: true; consentRecordId: string | null }
  | { eligible: false; reason: 'opted_out' | 'no_consent' | 'no_contact' };

/**
 * May this business contact this value on this channel for this purpose right now?
 * Called immediately before dispatch (PRD §10), not just when drafting.
 *
 * - Any withdrawal for the contact value + channel (any purpose) blocks: an opt-out
 *   from one message type is honoured across future sends.
 * - SMS requires an active recorded opt-in (PRD §4 step 5).
 * - Email for service reminders is allowed without a recorded opt-in unless opted out
 *   (existing customer relationship); marketing email requires an opt-in.
 */
export async function checkEligibility(
  db: Db,
  organizationId: string,
  channel: Channel,
  contactValue: string | null | undefined,
  purpose: Purpose,
): Promise<Eligibility> {
  if (!contactValue) return { eligible: false, reason: 'no_contact' };
  const value = normalizeContact(channel, contactValue);
  const rows = await db
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.organizationId, organizationId),
        eq(consentRecords.channel, channel),
        eq(consentRecords.contactValue, value),
      ),
    );
  if (rows.some((r) => r.withdrawnAt)) return { eligible: false, reason: 'opted_out' };
  const optIn = rows.find((r) => r.purpose === purpose && !r.withdrawnAt);
  if (optIn) return { eligible: true, consentRecordId: optIn.id };
  if (channel === 'email' && purpose === 'service_reminders') return { eligible: true, consentRecordId: null };
  return { eligible: false, reason: 'no_consent' };
}

/** Record an opt-out for a contact value even if no opt-in was ever recorded (e.g. unsubscribe link). */
export async function recordOptOut(
  tx: Db,
  args: { organizationId: string; customerId: string; channel: Channel; contactValue: string; source: string },
) {
  const value = normalizeContact(args.channel, args.contactValue);
  const active = await tx
    .select()
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.organizationId, args.organizationId),
        eq(consentRecords.channel, args.channel),
        eq(consentRecords.contactValue, value),
        isNull(consentRecords.withdrawnAt),
      ),
    );
  const now = new Date();
  if (active.length) {
    for (const r of active) {
      await tx
        .update(consentRecords)
        .set({ withdrawnAt: now, withdrawalSource: args.source })
        .where(eq(consentRecords.id, r.id));
    }
    return;
  }
  await tx.insert(consentRecords).values({
    organizationId: args.organizationId,
    customerId: args.customerId,
    channel: args.channel,
    contactValue: value,
    purpose: 'service_reminders',
    source: args.source,
    grantedAt: now,
    withdrawnAt: now,
    withdrawalSource: args.source,
  });
}

