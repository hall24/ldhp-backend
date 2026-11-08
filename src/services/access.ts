import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accounts, memberships, organizations } from '../db/schema.js';
import type { Role } from './context.js';
import type { VerifiedIdentity } from '../auth/verifier.js';

/** Find or create the platform account for a verified Clerk identity. */
export async function upsertAccount(db: Db, identity: VerifiedIdentity): Promise<{ id: string }> {
  const existing = await db
    .select({ id: accounts.id, deletedAt: accounts.deletedAt })
    .from(accounts)
    .where(eq(accounts.clerkUserId, identity.clerkUserId))
    .limit(1);
  if (existing[0]) {
    if (existing[0].deletedAt) throw new Error('account deleted');
    return { id: existing[0].id };
  }
  const [row] = await db
    .insert(accounts)
    .values({ clerkUserId: identity.clerkUserId })
    .onConflictDoUpdate({ target: accounts.clerkUserId, set: { updatedAt: new Date() } })
    .returning({ id: accounts.id });
  return { id: row!.id };
}

export interface OrgAccess {
  organizationId: string;
  role: Role;
  timeZone: string;
}

/**
 * The single authorization check for organization context. The organization id
 * comes from the client, so it is only accepted if the account has an ACTIVE
 * membership in a non-deleted organization. Returns null otherwise.
 */
export async function resolveOrgAccess(
  db: Db,
  accountId: string,
  organizationId: string,
): Promise<OrgAccess | null> {
  const rows = await db
    .select({ role: memberships.role, timeZone: organizations.timeZone })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(
        eq(memberships.accountId, accountId),
        eq(memberships.organizationId, organizationId),
        eq(memberships.status, 'active'),
        isNull(organizations.deletedAt),
      ),
    )
    .limit(1);
  const r = rows[0];
  return r ? { organizationId, role: r.role, timeZone: r.timeZone } : null;
}

export async function listMemberships(db: Db, accountId: string) {
  return db
    .select({
      organizationId: organizations.id,
      organizationName: organizations.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.organizationId))
    .where(
      and(eq(memberships.accountId, accountId), eq(memberships.status, 'active'), isNull(organizations.deletedAt)),
    );
}
