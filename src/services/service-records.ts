import { and, asc, desc, eq, isNull, lte, isNotNull } from 'drizzle-orm';
import { customers, organizations, serviceRecords } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { ScopedContext } from './context.js';
import { addDays, todayInZone } from '../lib/dates.js';
import { getCustomer } from './customers.js';
import { Errors } from '../lib/errors.js';
import type { Db } from '../db/client.js';

export type ServiceRecordRow = typeof serviceRecords.$inferSelect;

export function toServiceRecordDto(r: ServiceRecordRow) {
  return {
    id: r.id,
    customer_id: r.customerId,
    service_type: r.serviceType,
    completed_on: r.completedOn,
    interval_days: r.intervalDays,
    next_due_on: r.nextDueOn,
    notes: r.notes,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

export async function listServiceHistory(ctx: ScopedContext, customerId: string, limit = 50) {
  // Parent check first: a customer outside the caller's org is "not found".
  const customer = await getCustomer(ctx, customerId);
  if (!customer) return null;
  const rows = await ctx.db
    .select()
    .from(serviceRecords)
    .where(
      and(
        eq(serviceRecords.organizationId, ctx.organizationId),
        eq(serviceRecords.customerId, customerId),
        isNull(serviceRecords.deletedAt),
      ),
    )
    .orderBy(desc(serviceRecords.completedOn), desc(serviceRecords.createdAt))
    .limit(limit);
  return { customer, records: rows };
}

export interface ServiceRecordInput {
  serviceType: string;
  completedOn: string;
  intervalDays?: number | null;
  notes?: string | null;
}

export async function createServiceRecord(
  ctx: ScopedContext,
  customerId: string,
  input: ServiceRecordInput,
): Promise<ServiceRecordRow> {
  const customer = await getCustomer(ctx, customerId);
  if (!customer) throw Errors.notFound('Customer');
  const nextDueOn = input.intervalDays ? addDays(input.completedOn, input.intervalDays) : null;
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(serviceRecords)
      .values({
        organizationId: ctx.organizationId,
        customerId,
        serviceType: input.serviceType,
        completedOn: input.completedOn,
        intervalDays: input.intervalDays ?? null,
        nextDueOn,
        notes: input.notes ?? null,
        createdBy: ctx.actor.accountId,
      })
      .returning();
    await recordAudit(tx as unknown as Db, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'service.completed',
      recordType: 'service_record',
      recordId: row!.id,
      requestId: ctx.requestId,
      after: toServiceRecordDto(row!),
    });
    return row!;
  });
}

export interface DueItem {
  service_record_id: string;
  customer_id: string;
  customer_name: string;
  service_type: string;
  last_completed_on: string;
  next_due_on: string;
  days_until_due: number;
  status: 'overdue' | 'due_soon';
  /** The workspace's typical job value for this service type, in US cents, if set. */
  estimated_value_cents: number | null;
}

export interface DueSummary {
  overdue: number;
  due_soon: number;
  estimated_value_cents: number | null;
  items_without_value: number;
  currency: 'USD';
}

/** Counts and the revenue estimate shown above the due queue. */
export function summarizeDue(items: DueItem[]): DueSummary {
  let total = 0;
  let valued = 0;
  for (const i of items) {
    if (i.estimated_value_cents !== null) {
      total += i.estimated_value_cents;
      valued++;
    }
  }
  return {
    overdue: items.filter((i) => i.status === 'overdue').length,
    due_soon: items.filter((i) => i.status === 'due_soon').length,
    estimated_value_cents: valued > 0 ? total : null,
    items_without_value: items.length - valued,
    currency: 'USD',
  };
}

/**
 * Due queue: latest service per (customer, service type) whose next_due_on falls
 * on or before today + withinDays, in the organization's time zone. Suppressed
 * customers are excluded. Optionally narrowed to one customer.
 */
export async function listDue(
  ctx: ScopedContext,
  opts: { withinDays: number; customerId?: string; now?: Date },
): Promise<DueItem[]> {
  const today = todayInZone(ctx.timeZone, opts.now);
  const horizon = addDays(today, opts.withinDays);
  const rows = await ctx.db
    .select({ r: serviceRecords, customerName: customers.displayName })
    .from(serviceRecords)
    .innerJoin(
      customers,
      and(eq(customers.id, serviceRecords.customerId), eq(customers.organizationId, serviceRecords.organizationId)),
    )
    .where(
      and(
        eq(serviceRecords.organizationId, ctx.organizationId),
        isNull(serviceRecords.deletedAt),
        isNull(customers.deletedAt),
        eq(customers.suppressed, false),
        isNotNull(serviceRecords.nextDueOn),
        lte(serviceRecords.nextDueOn, horizon),
        opts.customerId ? eq(serviceRecords.customerId, opts.customerId) : undefined,
      ),
    )
    .orderBy(asc(serviceRecords.nextDueOn));

  // Keep only the most recent record per (customer, service type): a newer
  // completion supersedes an older due date.
  const latest = await latestCompletionByCustomerType(ctx, opts.customerId);
  const [org] = await ctx.db
    .select({ jobValuesCents: organizations.jobValuesCents })
    .from(organizations)
    .where(eq(organizations.id, ctx.organizationId))
    .limit(1);
  const values = org?.jobValuesCents ?? {};
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  return rows
    .filter(({ r }) => latest.get(`${r.customerId}|${r.serviceType}`) === r.id)
    .map(({ r, customerName }) => {
      const days = Math.round((Date.parse(`${r.nextDueOn}T00:00:00Z`) - todayMs) / 86_400_000);
      return {
        service_record_id: r.id,
        customer_id: r.customerId,
        customer_name: customerName,
        service_type: r.serviceType,
        last_completed_on: r.completedOn,
        next_due_on: r.nextDueOn!,
        days_until_due: days,
        status: days < 0 ? 'overdue' : 'due_soon',
        estimated_value_cents: Object.hasOwn(values, r.serviceType) ? values[r.serviceType]! : null,
      } satisfies DueItem;
    });
}

async function latestCompletionByCustomerType(ctx: ScopedContext, customerId?: string) {
  const rows = await ctx.db
    .select({
      id: serviceRecords.id,
      customerId: serviceRecords.customerId,
      serviceType: serviceRecords.serviceType,
    })
    .from(serviceRecords)
    .where(
      and(
        eq(serviceRecords.organizationId, ctx.organizationId),
        isNull(serviceRecords.deletedAt),
        customerId ? eq(serviceRecords.customerId, customerId) : undefined,
      ),
    )
    .orderBy(asc(serviceRecords.completedOn), asc(serviceRecords.createdAt));
  const m = new Map<string, string>();
  for (const r of rows) m.set(`${r.customerId}|${r.serviceType}`, r.id); // last wins
  return m;
}


export interface ServiceRecordPatch {
  serviceType?: string;
  completedOn?: string;
  intervalDays?: number | null;
  notes?: string | null;
  /** Explicit due date. Omit to recompute from completed_on + interval_days when either changes. */
  nextDueOn?: string | null;
}

const recordScope = (ctx: ScopedContext, customerId: string, id: string) =>
  and(
    eq(serviceRecords.organizationId, ctx.organizationId),
    eq(serviceRecords.customerId, customerId),
    eq(serviceRecords.id, id),
    isNull(serviceRecords.deletedAt),
  );

/**
 * Correct a service record (PRD §4 step 4: "correct a date"). Returns null if the
 * record (or its customer) is not in the caller's org.
 */
export async function updateServiceRecord(
  ctx: ScopedContext,
  customerId: string,
  id: string,
  patch: ServiceRecordPatch,
): Promise<ServiceRecordRow | null> {
  const customer = await getCustomer(ctx, customerId);
  if (!customer) return null;
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx.select().from(serviceRecords).where(recordScope(ctx, customerId, id)).for('update');
    if (!before) return null;

    const completedOn = patch.completedOn ?? before.completedOn;
    const intervalDays = patch.intervalDays !== undefined ? patch.intervalDays : before.intervalDays;
    let nextDueOn = before.nextDueOn;
    if (patch.nextDueOn !== undefined) nextDueOn = patch.nextDueOn;
    else if (patch.completedOn !== undefined || patch.intervalDays !== undefined) {
      nextDueOn = intervalDays ? addDays(completedOn, intervalDays) : null;
    }

    const [after] = await tx
      .update(serviceRecords)
      .set({
        serviceType: patch.serviceType ?? before.serviceType,
        completedOn,
        intervalDays,
        notes: patch.notes !== undefined ? patch.notes : before.notes,
        nextDueOn,
        updatedAt: new Date(),
      })
      .where(recordScope(ctx, customerId, id))
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'service.updated',
      recordType: 'service_record',
      recordId: id,
      requestId: ctx.requestId,
      before: toServiceRecordDto(before),
      after: toServiceRecordDto(after!),
    });
    return after!;
  });
}

/** Soft delete a record entered in error. The audit log keeps what it said. */
export async function deleteServiceRecord(ctx: ScopedContext, customerId: string, id: string): Promise<boolean> {
  const customer = await getCustomer(ctx, customerId);
  if (!customer) return false;
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .update(serviceRecords)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(recordScope(ctx, customerId, id))
      .returning();
    if (!row) return false;
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'service.deleted',
      recordType: 'service_record',
      recordId: id,
      requestId: ctx.requestId,
      before: toServiceRecordDto(row),
    });
    return true;
  });
}
