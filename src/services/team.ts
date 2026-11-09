/**
 * Team management (PRD §3, §8): owners invite staff by link, change roles, and
 * revoke access. Revocation takes effect on the next request because access is
 * re-checked against `memberships` every time.
 */
import { and, asc, count, eq, gt, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accounts, invitations, memberships, organizations } from '../db/schema.js';
import { recordAudit } from './audit.js';
import type { Actor, Role, ScopedContext } from './context.js';
import { ApiError, Errors } from '../lib/errors.js';
import { hashToken, looksLikeToken, newLinkToken } from '../lib/tokens.js';

export const INVITE_TTL_DAYS = 7;
export const MAX_PENDING_INVITES = 50;

export type InvitationRow = typeof invitations.$inferSelect;

export function invitationStatus(i: InvitationRow, now = new Date()) {
  if (i.acceptedAt) return 'accepted' as const;
  if (i.revokedAt) return 'revoked' as const;
  if (i.expiresAt <= now) return 'expired' as const;
  return 'pending' as const;
}

export function toInvitationDto(i: InvitationRow) {
  return {
    id: i.id,
    role: i.role,
    email: i.email,
    status: invitationStatus(i),
    expires_at: i.expiresAt.toISOString(),
    accepted_at: i.acceptedAt?.toISOString() ?? null,
    created_at: i.createdAt.toISOString(),
  };
}

const pendingWhere = (orgId: string, now: Date) =>
  and(
    eq(invitations.organizationId, orgId),
    isNull(invitations.acceptedAt),
    isNull(invitations.revokedAt),
    gt(invitations.expiresAt, now),
  );

/** Create an invite. The raw token is returned once and never stored. */
export async function createInvitation(
  ctx: ScopedContext,
  input: { role: Role; email: string | null },
): Promise<{ invitation: InvitationRow; token: string }> {
  const now = new Date();
  const [pending] = await ctx.db.select({ n: count() }).from(invitations).where(pendingWhere(ctx.organizationId, now));
  if ((pending?.n ?? 0) >= MAX_PENDING_INVITES) {
    throw new ApiError(409, 'too_many_invitations', 'Revoke some pending invitations before creating more.');
  }
  const token = newLinkToken();
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .insert(invitations)
      .values({
        organizationId: ctx.organizationId,
        role: input.role,
        email: input.email,
        tokenHash: hashToken(token),
        expiresAt: new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000),
        createdBy: ctx.actor.accountId,
      })
      .returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'invitation.created',
      recordType: 'invitation',
      recordId: row!.id,
      requestId: ctx.requestId,
      after: { role: row!.role, has_email: !!row!.email, expires_at: row!.expiresAt.toISOString() },
    });
    return { invitation: row!, token };
  });
}

export async function listInvitations(ctx: ScopedContext) {
  return ctx.db
    .select()
    .from(invitations)
    .where(pendingWhere(ctx.organizationId, new Date()))
    .orderBy(asc(invitations.createdAt));
}

export async function revokeInvitation(ctx: ScopedContext, id: string): Promise<boolean> {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [row] = await tx
      .update(invitations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(invitations.organizationId, ctx.organizationId),
          eq(invitations.id, id),
          isNull(invitations.acceptedAt),
          isNull(invitations.revokedAt),
        ),
      )
      .returning();
    if (!row) return false;
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'invitation.revoked',
      recordType: 'invitation',
      recordId: id,
      requestId: ctx.requestId,
    });
    return true;
  });
}

const invalidInvite = () =>
  new ApiError(404, 'invitation_invalid', 'This invitation link is invalid, expired, or already used.');

/**
 * Accept an invite as the signed-in account. Expired, revoked, used and unknown
 * tokens all get the same answer. A previously revoked membership is reactivated.
 */
export async function acceptInvitation(
  db: Db,
  actor: Actor & { accountId: string },
  token: string,
  requestId: string,
): Promise<{ organizationId: string; organizationName: string; role: Role }> {
  const tokenHash = looksLikeToken(token) ? hashToken(token) : null;
  const result = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [inv] = tokenHash
      ? await tx.select().from(invitations).where(eq(invitations.tokenHash, tokenHash)).for('update')
      : [];
    if (!inv || invitationStatus(inv) !== 'pending') {
      return { denied: true as const, inv: inv ?? null };
    }
    const [org] = await tx
      .select({ name: organizations.name })
      .from(organizations)
      .where(and(eq(organizations.id, inv.organizationId), isNull(organizations.deletedAt)));
    if (!org) return { denied: true as const, inv };

    const [existing] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.organizationId, inv.organizationId), eq(memberships.accountId, actor.accountId)))
      .for('update');
    if (existing?.status === 'active') {
      // Don't burn the link: it may have been meant for someone else on the team.
      throw new ApiError(409, 'already_member', 'You are already a member of this workspace.');
    }
    if (existing) {
      await tx
        .update(memberships)
        .set({ status: 'active', role: inv.role, revokedAt: null })
        .where(eq(memberships.id, existing.id));
    } else {
      await tx
        .insert(memberships)
        .values({ organizationId: inv.organizationId, accountId: actor.accountId, role: inv.role });
    }
    await tx
      .update(invitations)
      .set({ acceptedAt: new Date(), acceptedBy: actor.accountId })
      .where(eq(invitations.id, inv.id));
    await recordAudit(tx, {
      actor,
      organizationId: inv.organizationId,
      action: 'invitation.accepted',
      recordType: 'invitation',
      recordId: inv.id,
      requestId,
      after: { role: inv.role, reactivated: !!existing },
    });
    return {
      denied: false as const,
      value: { organizationId: inv.organizationId, organizationName: org.name, role: inv.role },
    };
  });

  if (result.denied) {
    // Recorded outside the transaction so the denial is kept.
    const inv = result.inv;
    await recordAudit(db, {
      actor,
      organizationId: inv?.organizationId ?? null,
      action: 'invitation.accept_denied',
      outcome: 'denied',
      recordType: inv ? 'invitation' : undefined,
      recordId: inv?.id,
      requestId,
      metadata: { reason: inv ? invitationStatus(inv) : 'unknown_token' },
    });
    throw invalidInvite();
  }
  return result.value;
}

// --------------------------------------------------------------------- members

export async function listMembers(ctx: ScopedContext) {
  return ctx.db
    .select({
      id: memberships.id,
      accountId: memberships.accountId,
      role: memberships.role,
      createdAt: memberships.createdAt,
      displayName: accounts.displayName,
      email: accounts.email,
    })
    .from(memberships)
    .innerJoin(accounts, eq(accounts.id, memberships.accountId))
    .where(and(eq(memberships.organizationId, ctx.organizationId), eq(memberships.status, 'active')))
    .orderBy(asc(memberships.createdAt));
}

async function otherActiveOwners(tx: Db, orgId: string, excludingMembershipId: string) {
  const [r] = await tx
    .select({ n: count() })
    .from(memberships)
    .where(
      and(
        eq(memberships.organizationId, orgId),
        eq(memberships.status, 'active'),
        eq(memberships.role, 'owner'),
        ne(memberships.id, excludingMembershipId),
      ),
    );
  return r?.n ?? 0;
}

const lastOwner = () =>
  new ApiError(409, 'last_owner', 'A workspace must keep at least one owner. Make someone else an owner first.');

/**
 * Lock the org's active memberships so two concurrent changes can't both pass the
 * "another owner remains" check and leave the workspace ownerless.
 */
async function lockMemberships(tx: Db, orgId: string) {
  await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.organizationId, orgId), eq(memberships.status, 'active')))
    .for('update');
}

export async function changeMemberRole(ctx: ScopedContext, membershipId: string, role: Role) {
  return ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockMemberships(tx, ctx.organizationId);
    const [m] = await tx
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, ctx.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.status, 'active'),
        ),
      );
    if (!m) throw Errors.notFound('Member');
    if (m.role === role) return m;
    if (m.role === 'owner' && (await otherActiveOwners(tx, ctx.organizationId, m.id)) === 0) throw lastOwner();
    const [after] = await tx.update(memberships).set({ role }).where(eq(memberships.id, m.id)).returning();
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'membership.role_changed',
      recordType: 'membership',
      recordId: m.id,
      requestId: ctx.requestId,
      before: { role: m.role },
      after: { role },
      metadata: { account_id: m.accountId },
    });
    return after!;
  });
}

export async function revokeMember(ctx: ScopedContext, membershipId: string): Promise<void> {
  await ctx.db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await lockMemberships(tx, ctx.organizationId);
    const [m] = await tx
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, ctx.organizationId),
          eq(memberships.id, membershipId),
          eq(memberships.status, 'active'),
        ),
      );
    if (!m) throw Errors.notFound('Member');
    if (m.role === 'owner' && (await otherActiveOwners(tx, ctx.organizationId, m.id)) === 0) throw lastOwner();
    await tx
      .update(memberships)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(memberships.id, m.id));
    await recordAudit(tx, {
      actor: ctx.actor,
      organizationId: ctx.organizationId,
      action: 'membership.revoked',
      recordType: 'membership',
      recordId: m.id,
      requestId: ctx.requestId,
      before: { role: m.role, status: 'active' },
      after: { status: 'revoked' },
      metadata: { account_id: m.accountId },
    });
  });
}
