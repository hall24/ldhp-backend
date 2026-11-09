import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, invitations } from '../src/db/schema.js';
import { setup } from './helpers/app.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  t = await setup();
});
afterAll(async () => t.teardown());

const newbie = { clerkUserId: 'user_test_invitee' };

async function invite(payload: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/invitations',
    headers: t.as(t.SEED.ownerA, t.SEED.orgA),
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { invitation: { id: string; status: string }; invite_token: string };
}

const accept = (who: { clerkUserId: string }, token: string) =>
  t.app.inject({ method: 'POST', url: '/v1/invitations/accept', headers: t.as(who), payload: { token } });

async function memberIdFor(accountClerkId: string) {
  const me = await t.app.inject({ method: 'GET', url: '/v1/me', headers: t.as({ clerkUserId: accountClerkId }) });
  const accountId = me.json().account_id;
  const list = await t.app.inject({ method: 'GET', url: '/v1/members', headers: t.as(t.SEED.ownerA, t.SEED.orgA) });
  return (list.json().data as Array<{ id: string; account_id: string }>).find((m) => m.account_id === accountId)!.id;
}

describe('invitations', () => {
  it('only owners can invite', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/invitations',
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('stores only a hash of the token', async () => {
    const { invitation, invite_token } = await invite({ email: 'invitee@example.test' });
    expect(invitation.status).toBe('pending');
    const [row] = await t.db.select().from(invitations).where(eq(invitations.id, invitation.id));
    expect(row!.tokenHash).not.toContain(invite_token);
    expect(JSON.stringify(row)).not.toContain(invite_token);
  });

  it('lets an invitee join as staff once, and the link cannot be reused', async () => {
    const { invite_token } = await invite();
    const res = await accept(newbie, invite_token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ organization_id: t.SEED.orgA, role: 'staff' });

    const customers = await t.app.inject({ method: 'GET', url: '/v1/customers', headers: t.as(newbie, t.SEED.orgA) });
    expect(customers.statusCode).toBe(200);

    const reuse = await accept({ clerkUserId: 'user_test_someone_else' }, invite_token);
    expect(reuse.statusCode).toBe(404);
    expect(reuse.json().error.code).toBe('invitation_invalid');
  });

  it('gives the same answer for unknown, revoked and expired tokens, and audits denials', async () => {
    const unknown = await accept(newbie, 'A'.repeat(43));
    const junk = await accept(newbie, 'not-a-token');

    const revoked = await invite();
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/v1/invitations/${revoked.invitation.id}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
    });
    expect(del.statusCode).toBe(204);
    const revokedRes = await accept({ clerkUserId: 'user_test_r' }, revoked.invite_token);

    const expired = await invite();
    await t.db
      .update(invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(invitations.id, expired.invitation.id));
    const expiredRes = await accept({ clerkUserId: 'user_test_e' }, expired.invite_token);

    for (const r of [unknown, junk, revokedRes, expiredRes]) {
      expect(r.statusCode).toBe(404);
      expect(r.json().error.message).toBe(unknown.json().error.message);
    }
    const denials = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'invitation.accept_denied'));
    expect(denials.length).toBeGreaterThanOrEqual(4);
  });

  it('does not consume the link when the caller is already a member', async () => {
    const { invite_token, invitation } = await invite();
    const res = await accept(t.SEED.staffA, invite_token);
    expect(res.statusCode).toBe(409);
    const [row] = await t.db.select().from(invitations).where(eq(invitations.id, invitation.id));
    expect(row!.acceptedAt).toBeNull();
  });

  it('lists only pending invitations and cannot revoke another org invite', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/v1/invitations', headers: t.as(t.SEED.ownerA, t.SEED.orgA) });
    expect(list.json().data.every((i: { status: string }) => i.status === 'pending')).toBe(true);

    const mine = await invite();
    const cross = await t.app.inject({
      method: 'DELETE',
      url: `/v1/invitations/${mine.invitation.id}`,
      headers: t.as(t.SEED.ownerB, t.SEED.orgB),
    });
    expect(cross.statusCode).toBe(404);
  });
});

describe('members', () => {
  it('lets staff see the team but not change it', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/v1/members', headers: t.as(t.SEED.staffA, t.SEED.orgA) });
    expect(list.statusCode).toBe(200);
    const staffId = await memberIdFor(t.SEED.staffA.clerkUserId);
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/members/${staffId}`,
      headers: t.as(t.SEED.staffA, t.SEED.orgA),
      payload: { role: 'owner' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses to demote or remove the last owner', async () => {
    const ownerId = await memberIdFor(t.SEED.ownerA.clerkUserId);
    const demote = await t.app.inject({
      method: 'PATCH',
      url: `/v1/members/${ownerId}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
      payload: { role: 'staff' },
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('last_owner');
    const remove = await t.app.inject({
      method: 'DELETE',
      url: `/v1/members/${ownerId}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
    });
    expect(remove.statusCode).toBe(409);
  });

  it('changes a role with an audit record, then revokes access immediately', async () => {
    const id = await memberIdFor(newbie.clerkUserId);
    const promote = await t.app.inject({
      method: 'PATCH',
      url: `/v1/members/${id}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
      payload: { role: 'owner' },
    });
    expect(promote.json()).toMatchObject({ role: 'owner' });
    const [ev] = await t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'membership.role_changed'), eq(auditEvents.recordId, id)));
    expect(ev).toMatchObject({ before: { role: 'staff' }, after: { role: 'owner' } });

    const revoke = await t.app.inject({
      method: 'DELETE',
      url: `/v1/members/${id}`,
      headers: t.as(t.SEED.ownerA, t.SEED.orgA),
    });
    expect(revoke.statusCode).toBe(204);
    const after = await t.app.inject({ method: 'GET', url: '/v1/customers', headers: t.as(newbie, t.SEED.orgA) });
    expect(after.statusCode).toBe(403);
  });

  it('reactivates a revoked member who accepts a new invite', async () => {
    const { invite_token } = await invite();
    const res = await accept(newbie, invite_token);
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('staff');
  });

  it("cannot change another org's member", async () => {
    const id = await memberIdFor(t.SEED.staffA.clerkUserId);
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/v1/members/${id}`,
      headers: t.as(t.SEED.ownerB, t.SEED.orgB),
    });
    expect(res.statusCode).toBe(404);
  });
});
