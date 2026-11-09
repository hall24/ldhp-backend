import { and, asc, eq, gt, isNull, or } from 'drizzle-orm';
import { customers } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { ScopedContext } from './context.js';
import { decodeCursor, encodeCursor } from '../lib/cursor.js';

export type CustomerRow = typeof customers.$inferSelect;

export interface CustomerInput {
  displayName: string;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  notes?: string | null;
}

export function toCustomerDto(c: CustomerRow) {
  return {
    id: c.id,
    display_name: c.displayName,
    email: c.email,
    phone: c.phone,
    address: {
      line1: c.addressLine1,
      line2: c.addressLine2,
      city: c.city,
      region: c.region,
      postal_code: c.postalCode,
    },
    suppressed: c.suppressed,
    notes: c.notes,
    created_at: c.createdAt.toISOString(),
    updated_at: c.updatedAt.toISOString(),
  };
}

/** Every customer read goes through this predicate: owned by the caller's org, not deleted. */
const scoped = (ctx: ScopedContext) =>
  and(eq(customers.organizationId, ctx.organizationId), isNull(customers.deletedAt));

export async function getCustomer(ctx: ScopedContext, id: string): Promise<CustomerRow | null> {
  const rows = await ctx.db
    .select()
    .from(customers)
    .where(and(scoped(ctx), eq(customers.id, id)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listCustomers(ctx: ScopedContext, opts: { limit: number; cursor?: string }) {
  const c = opts.cursor ? decodeCursor(opts.cursor) : null;
  const after = c
    ? or(
        gt(customers.createdAt, new Date(c.t)),
        and(eq(customers.createdAt, new Date(c.t)), gt(customers.id, c.id)),
      )
    : undefined;
  const rows = await ctx.db
    .select()
    .from(customers)
    .where(and(scoped(ctx), after))
    .orderBy(asc(customers.createdAt), asc(customers.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    data: page,
    nextCursor: rows.length > opts.limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}

export async function createCustomer(ctx: ScopedContext, input: CustomerInput): Promise<CustomerRow> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(customers)
      .values({ ...input, organizationId: ctx.organizationId, createdBy: ctx.actor.accountId })
      .returning();
    await recordAudit(tx as unknown as typeof ctx.db, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'customer.created',
      recordType: 'customer',
      recordId: row!.id,
      requestId: ctx.requestId,
      // Audit stores field presence for contact details, not the values themselves.
      after: { display_name: row!.displayName, has_email: !!row!.email, has_phone: !!row!.phone },
    });
    return row!;
  });
}

export type CustomerPatch = Partial<CustomerInput> & { suppressed?: boolean };

/** Audit view of a customer: contact details as presence flags, never values. */
const auditView = (c: CustomerRow) => ({
  display_name: c.displayName,
  has_email: !!c.email,
  has_phone: !!c.phone,
  has_address: !!(c.addressLine1 || c.city || c.postalCode),
  suppressed: c.suppressed,
});

/**
 * Edit a customer, including suppressing them from the due queue (PRD §4 step 4).
 * Returns null when the customer is not in the caller's org.
 */
export async function updateCustomer(
  ctx: ScopedContext,
  id: string,
  patch: CustomerPatch,
): Promise<CustomerRow | null> {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as typeof ctx.db;
    const [before] = await tx
      .select()
      .from(customers)
      .where(and(scoped(ctx), eq(customers.id, id)))
      .for('update');
    if (!before) return null;
    const [after] = await tx
      .update(customers)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(scoped(ctx), eq(customers.id, id)))
      .returning();
    const changed = Object.keys(patch);
    const suppressionChanged = patch.suppressed !== undefined && patch.suppressed !== before.suppressed;
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: suppressionChanged
        ? after!.suppressed
          ? 'customer.suppressed'
          : 'customer.unsuppressed'
        : 'customer.updated',
      recordType: 'customer',
      recordId: id,
      requestId: ctx.requestId,
      before: auditView(before),
      after: auditView(after!),
      metadata: { changed_fields: changed },
    });
    return after!;
  });
}

/** Soft delete. Service history stays for audit; the customer disappears from lists and the due queue. */
export async function deleteCustomer(ctx: ScopedContext, id: string): Promise<boolean> {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as typeof ctx.db;
    const [row] = await tx
      .update(customers)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(scoped(ctx), eq(customers.id, id)))
      .returning();
    if (!row) return false;
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'customer.deleted',
      recordType: 'customer',
      recordId: id,
      requestId: ctx.requestId,
      before: auditView(row),
    });
    return true;
  });
}
