import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { memberships, organizations } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { Actor, ScopedContext } from './context.js';
import { Errors } from '../lib/errors.js';

export type OrganizationRow = typeof organizations.$inferSelect;

export interface OrganizationSettings {
  name?: string;
  timeZone?: string;
  messageFromName?: string | null;
  serviceTypes?: string[];
  serviceArea?: string | null;
  replyToEmail?: string | null;
  mailingAddress?: string | null;
}

/** True if `tz` is an IANA zone the runtime understands (the due queue depends on it). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validateSettings(s: OrganizationSettings) {
  if (s.timeZone !== undefined && !isValidTimeZone(s.timeZone)) {
    throw Errors.validation({ time_zone: 'unknown IANA time zone' });
  }
  if (s.serviceTypes) {
    const normalized = s.serviceTypes.map((t) => t.trim());
    if (normalized.some((t) => !t)) throw Errors.validation({ service_types: 'empty value' });
    if (new Set(normalized).size !== normalized.length) {
      throw Errors.validation({ service_types: 'duplicate value' });
    }
    s.serviceTypes = normalized;
  }
}

export function toOrganizationDto(o: OrganizationRow, role?: string) {
  return {
    id: o.id,
    name: o.name,
    time_zone: o.timeZone,
    message_from_name: o.messageFromName,
    service_types: o.serviceTypes,
    service_area: o.serviceArea,
    reply_to_email: o.replyToEmail,
    mailing_address: o.mailingAddress,
    created_at: o.createdAt.toISOString(),
    updated_at: o.updatedAt.toISOString(),
    ...(role ? { role } : {}),
  };
}

const auditView = (o: OrganizationRow) => ({
  name: o.name,
  time_zone: o.timeZone,
  message_from_name: o.messageFromName,
  service_types: o.serviceTypes,
  service_area: o.serviceArea,
  reply_to_email: o.replyToEmail,
  mailing_address: o.mailingAddress,
});

/**
 * Self-serve workspace creation (PRD §4 step 1, "set up without support"). The
 * creator becomes the only owner. A retried request with the same Idempotency-Key
 * returns the workspace created the first time.
 */
export async function createOrganization(
  db: Db,
  actor: Actor & { accountId: string },
  input: OrganizationSettings & { name: string },
  opts: { requestId: string; idempotencyKey?: string },
): Promise<{ org: OrganizationRow; replayed: boolean }> {
  validateSettings(input);
  if (opts.idempotencyKey) {
    const existing = await findByCreationKey(db, actor.accountId, opts.idempotencyKey);
    if (existing) return { org: existing, replayed: true };
  }
  try {
    return await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [org] = await tx
        .insert(organizations)
        .values({
          name: input.name,
          timeZone: input.timeZone ?? 'America/New_York',
          messageFromName: input.messageFromName ?? null,
          serviceTypes: input.serviceTypes ?? [],
          serviceArea: input.serviceArea ?? null,
          replyToEmail: input.replyToEmail ?? null,
          mailingAddress: input.mailingAddress ?? null,
          createdBy: actor.accountId,
          creationKey: opts.idempotencyKey ?? null,
        })
        .returning();
      await tx.insert(memberships).values({ organizationId: org!.id, accountId: actor.accountId, role: 'owner' });
      await recordAudit(tx, {
        actor,
        organizationId: org!.id,
        action: 'organization.created',
        recordType: 'organization',
        recordId: org!.id,
        requestId: opts.requestId,
        after: auditView(org!),
      });
      return { org: org!, replayed: false };
    });
  } catch (err) {
    // Concurrent duplicate with the same key lost the race on the unique index.
    if (opts.idempotencyKey) {
      const existing = await findByCreationKey(db, actor.accountId, opts.idempotencyKey);
      if (existing) return { org: existing, replayed: true };
    }
    throw err;
  }
}

async function findByCreationKey(db: Db, accountId: string, key: string) {
  const rows = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.createdBy, accountId), eq(organizations.creationKey, key)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getOrganization(ctx: ScopedContext): Promise<OrganizationRow> {
  const rows = await ctx.db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, ctx.organizationId), isNull(organizations.deletedAt)))
    .limit(1);
  if (!rows[0]) throw Errors.notFound('Organization');
  return rows[0];
}

export async function updateOrganization(ctx: ScopedContext, patch: OrganizationSettings): Promise<OrganizationRow> {
  validateSettings(patch);
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [before] = await tx
      .select()
      .from(organizations)
      .where(and(eq(organizations.id, ctx.organizationId), isNull(organizations.deletedAt)))
      .for('update');
    if (!before) throw Errors.notFound('Organization');
    const [after] = await tx
      .update(organizations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(organizations.id, ctx.organizationId))
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'organization.updated',
      recordType: 'organization',
      recordId: ctx.organizationId,
      requestId: ctx.requestId,
      before: auditView(before),
      after: auditView(after!),
    });
    return after!;
  });
}
