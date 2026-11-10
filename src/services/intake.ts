/**
 * Intake requests (PRD §4 steps 7-9). Staff (or, later, an outreach send) create a
 * request with a signed, single-purpose link. The customer opens the link, without an
 * account, and answers. Staff then work it through the intake queue.
 *
 * The link token is 256-bit random, shown once, and only its hash is stored. It expires
 * after 14 days, can be revoked, and grants access to exactly one request.
 */
import { and, asc, desc, eq, gt, isNull, lt, notInArray, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { customers, intakeEvents, intakeRequests, organizations } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { Actor, ScopedContext } from './context.js';
import { getCustomer } from './customers.js';
import { recordOptOut } from './consent.js';
import { ApiError, Errors } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';
import { hashToken, looksLikeToken, newLinkToken } from '../lib/tokens.js';

export const LINK_TTL_DAYS = 14;

export type IntakeRow = typeof intakeRequests.$inferSelect;
export type IntakeStatus = IntakeRow['status'];
export type IntakeResponse = NonNullable<IntakeRow['response']>;

/** Statuses staff may set. awaiting_response/received are set by the system and the customer. */
export const STAFF_STATUSES = ['contacted', 'scheduled_externally', 'not_proceeding', 'unable_to_reach'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];
/** Closed outcomes (PRD §4 step 9). */
const CLOSED: IntakeStatus[] = ['scheduled_externally', 'not_proceeding'];

export function linkState(r: IntakeRow, now = new Date()) {
  if (r.linkRevokedAt) return 'revoked' as const;
  if (r.linkExpiresAt <= now) return 'expired' as const;
  return 'active' as const;
}

export function toIntakeDto(r: IntakeRow, customerName?: string) {
  return {
    id: r.id,
    customer_id: r.customerId,
    ...(customerName !== undefined ? { customer_name: customerName } : {}),
    service_type: r.serviceType,
    status: r.status,
    response: r.response,
    customer_note: r.customerNote,
    responded_at: r.respondedAt?.toISOString() ?? null,
    link_state: linkState(r),
    link_expires_at: r.linkExpiresAt.toISOString(),
    status_changed_at: r.statusChangedAt?.toISOString() ?? null,
    status_changed_by: r.statusChangedBy,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

async function addEvent(
  tx: Db,
  e: { organizationId: string; intakeRequestId: string; from: IntakeStatus | null; to: IntakeStatus; actor: Actor; note?: string | null },
) {
  await tx.insert(intakeEvents).values({
    organizationId: e.organizationId,
    intakeRequestId: e.intakeRequestId,
    fromStatus: e.from,
    toStatus: e.to,
    actorType: e.actor.type,
    actorAccountId: e.actor.accountId,
    note: e.note ?? null,
  });
}

/** Create a request and its link. Returns the raw token once. */
export async function createIntakeRequest(
  ctx: ScopedContext,
  customerId: string,
  input: { serviceType?: string | null },
): Promise<{ request: IntakeRow; token: string }> {
  const customer = await getCustomer(ctx, customerId);
  if (!customer) throw Errors.notFound('Customer');
  const token = newLinkToken();
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(intakeRequests)
      .values({
        organizationId: ctx.organizationId,
        customerId,
        serviceType: input.serviceType ?? null,
        createdBy: ctx.actor.accountId,
        linkTokenHash: hashToken(token),
        linkExpiresAt: new Date(Date.now() + LINK_TTL_DAYS * 86_400_000),
      })
      .returning();
    await addEvent(tx, {
      organizationId: ctx.organizationId,
      intakeRequestId: row!.id,
      from: null,
      to: 'awaiting_response',
      actor: ctx.actor,
    });
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'intake.created',
      recordType: 'intake_request',
      recordId: row!.id,
      requestId: ctx.requestId,
      after: { customer_id: customerId, service_type: row!.serviceType },
    });
    return { request: row!, token };
  });
}

const scope = (ctx: ScopedContext, id: string) =>
  and(eq(intakeRequests.organizationId, ctx.organizationId), eq(intakeRequests.id, id));

export async function getIntakeRequest(ctx: ScopedContext, id: string) {
  const [row] = await ctx.db
    .select({ r: intakeRequests, customerName: customers.displayName })
    .from(intakeRequests)
    .innerJoin(
      customers,
      and(eq(customers.id, intakeRequests.customerId), eq(customers.organizationId, intakeRequests.organizationId)),
    )
    .where(scope(ctx, id))
    .limit(1);
  if (!row) return null;
  const history = await ctx.db
    .select()
    .from(intakeEvents)
    .where(and(eq(intakeEvents.organizationId, ctx.organizationId), eq(intakeEvents.intakeRequestId, id)))
    .orderBy(asc(intakeEvents.occurredAt), asc(intakeEvents.id));
  return { ...row, history };
}

/** The intake queue, newest first. `open` = anything not closed. */
export async function listIntakeRequests(
  ctx: ScopedContext,
  opts: { status?: IntakeStatus | 'open'; limit: number; cursor?: string },
) {
  const c = opts.cursor ? decodeCursor(opts.cursor) : null;
  const before = c
    ? or(
        lt(intakeRequests.createdAt, new Date(c.t)),
        and(eq(intakeRequests.createdAt, new Date(c.t)), lt(intakeRequests.id, c.id)),
      )
    : undefined;
  const statusFilter =
    opts.status === 'open'
      ? notInArray(intakeRequests.status, CLOSED)
      : opts.status
        ? eq(intakeRequests.status, opts.status)
        : undefined;
  const rows = await ctx.db
    .select({ r: intakeRequests, customerName: customers.displayName })
    .from(intakeRequests)
    .innerJoin(
      customers,
      and(eq(customers.id, intakeRequests.customerId), eq(customers.organizationId, intakeRequests.organizationId)),
    )
    .where(and(eq(intakeRequests.organizationId, ctx.organizationId), statusFilter, before))
    .orderBy(desc(intakeRequests.createdAt), desc(intakeRequests.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    data: page,
    nextCursor: rows.length > opts.limit && last ? encodeCursor(last.r.createdAt, last.r.id) : null,
  };
}

/** Staff move a request through its statuses. Every change is attributed and kept in history. */
export async function updateIntakeStatus(ctx: ScopedContext, id: string, to: StaffStatus, note: string | null) {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx.select().from(intakeRequests).where(scope(ctx, id)).for('update');
    if (!row) throw Errors.notFound('Intake request');
    if (row.status === to) throw new ApiError(409, 'no_change', `The request is already ${to}.`);
    const now = new Date();
    const [after] = await tx
      .update(intakeRequests)
      .set({ status: to, statusChangedBy: ctx.actor.accountId, statusChangedAt: now, updatedAt: now })
      .where(scope(ctx, id))
      .returning();
    await addEvent(tx, {
      organizationId: ctx.organizationId,
      intakeRequestId: id,
      from: row.status,
      to,
      actor: ctx.actor,
      note,
    });
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: CLOSED.includes(to) ? 'intake.closed' : 'intake.status_changed',
      recordType: 'intake_request',
      recordId: id,
      requestId: ctx.requestId,
      before: { status: row.status },
      after: { status: to },
    });
    return after!;
  });
}

export async function revokeIntakeLink(ctx: ScopedContext, id: string) {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .update(intakeRequests)
      .set({ linkRevokedAt: new Date(), updatedAt: new Date() })
      .where(and(scope(ctx, id), isNull(intakeRequests.linkRevokedAt)))
      .returning();
    if (!row) {
      // Already revoked (idempotent) or not in this org.
      const [cur] = await tx.select().from(intakeRequests).where(scope(ctx, id));
      if (!cur) throw Errors.notFound('Intake request');
      return cur;
    }
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'intake.link_revoked',
      recordType: 'intake_request',
      recordId: id,
      requestId: ctx.requestId,
    });
    return row;
  });
}

// ------------------------------------------------------------------ customer link

const invalidLink = () =>
  new ApiError(404, 'link_invalid', 'This link is invalid or has expired. Please contact the business directly.');

/** Statuses in which the customer may still (re)submit their answer. */
const ANSWERABLE: IntakeStatus[] = ['awaiting_response', 'received'];

async function findByToken(db: Db, token: string, forUpdate: boolean) {
  if (!looksLikeToken(token)) return null;
  const q = db
    .select({
      r: intakeRequests,
      businessName: organizations.name,
      fromName: organizations.messageFromName,
      bookingUrl: organizations.bookingUrl,
    })
    .from(intakeRequests)
    .innerJoin(organizations, eq(organizations.id, intakeRequests.organizationId))
    .innerJoin(
      customers,
      and(eq(customers.id, intakeRequests.customerId), eq(customers.organizationId, intakeRequests.organizationId)),
    )
    .where(
      and(
        eq(intakeRequests.linkTokenHash, hashToken(token)),
        isNull(intakeRequests.linkRevokedAt),
        gt(intakeRequests.linkExpiresAt, new Date()),
        isNull(organizations.deletedAt),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);
  const [row] = forUpdate ? await q.for('update', { of: intakeRequests }) : await q;
  return row ?? null;
}

const linkActor: Actor = { type: 'customer_link', accountId: null, label: 'customer link' };

/**
 * What the customer sees: the business name and whether they can answer. Nothing
 * about the customer record, other requests, or service history.
 */
export async function viewByToken(db: Db, token: string) {
  const row = await findByToken(db, token, false);
  if (!row) throw invalidLink();
  return {
    business_name: row.fromName || row.businessName,
    service_type: row.r.serviceType,
    can_respond: ANSWERABLE.includes(row.r.status),
    response: row.r.response,
    expires_at: row.r.linkExpiresAt.toISOString(),
    booking_url: row.bookingUrl,
  };
}

export async function respondByToken(
  db: Db,
  token: string,
  input: { response: IntakeResponse; note: string | null; unsubscribe: boolean },
  requestId: string,
) {
  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const row = await findByToken(tx, token, true);
    if (!row) return null;
    const r = row.r;
    if (!ANSWERABLE.includes(r.status)) {
      throw new ApiError(409, 'already_handled', 'The business is already following up on this request.');
    }
    const now = new Date();
    await tx
      .update(intakeRequests)
      .set({ response: input.response, customerNote: input.note, respondedAt: now, status: 'received', updatedAt: now })
      .where(eq(intakeRequests.id, r.id));
    await addEvent(tx, {
      organizationId: r.organizationId,
      intakeRequestId: r.id,
      from: r.status,
      to: 'received',
      actor: linkActor,
      note: `customer answered: ${input.response}`,
    });
    if (input.unsubscribe) {
      const [cust] = await tx.select({ email: customers.email }).from(customers).where(eq(customers.id, r.customerId));
      if (cust?.email) {
        await recordOptOut(tx, {
          organizationId: r.organizationId,
          customerId: r.customerId,
          channel: 'email',
          contactValue: cust.email,
          source: 'customer_link_unsubscribe',
        });
      }
    }
    await recordAudit(tx, {
      actor: linkActor,
      organizationId: r.organizationId,
      action: 'intake.received',
      recordType: 'intake_request',
      recordId: r.id,
      requestId,
      after: { response: input.response, has_note: !!input.note, unsubscribed: input.unsubscribe },
    });
    return { business_name: row.fromName || row.businessName, response: input.response, booking_url: row.bookingUrl };
  });
  if (!result) throw invalidLink();
  return result;
}
