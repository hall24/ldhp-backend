import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Db } from '../db/client.js';
import type { TokenVerifier } from './verifier.js';
import { resolveOrgAccess, upsertAccount } from '../services/access.js';
import type { Role, ScopedContext } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { Errors } from '../lib/errors.js';
import { isUuid } from '../lib/ids.js';

export const ORG_HEADER = 'x-organization-id';

declare module 'fastify' {
  interface FastifyRequest {
    accountId: string | null;
    scoped: ScopedContext | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireOrg: (roles?: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** Typed accessor for handlers behind `requireOrg`. */
export function scopedOf(req: FastifyRequest): ScopedContext {
  if (!req.scoped) throw new Error('route is missing requireOrg hook');
  return req.scoped;
}

export const authPlugin = fp(async (app: FastifyInstance, opts: { db: Db; verifier: TokenVerifier }) => {
  const { db, verifier } = opts;
  app.decorateRequest('accountId', null);
  app.decorateRequest('scoped', null);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw Errors.unauthenticated();
    let identity;
    try {
      identity = await verifier.verify(token);
    } catch (err) {
      req.log.info({ err: (err as Error).message }, 'token verification failed');
      throw Errors.unauthenticated();
    }
    try {
      req.accountId = (await upsertAccount(db, identity)).id;
    } catch {
      throw Errors.unauthenticated();
    }
  });

  /**
   * Organization scope. The client says which org it wants via X-Organization-Id;
   * the server only accepts it after verifying an active membership. Denials are
   * audited. "Org doesn't exist" and "not a member" are indistinguishable.
   */
  app.decorate('requireOrg', (roles?: Role[]) => async (req: FastifyRequest) => {
    await app.authenticate(req, undefined as never);
    const accountId = req.accountId!;
    const orgId = req.headers[ORG_HEADER];
    if (typeof orgId !== 'string' || !orgId) throw Errors.orgRequired();

    const access = isUuid(orgId) ? await resolveOrgAccess(db, accountId, orgId) : null;
    const actor = { type: 'user' as const, accountId };
    if (!access) {
      await recordAudit(db, {
        actor,
        organizationId: isUuid(orgId) ? orgId : null,
        action: 'authz.org_access_denied',
        outcome: 'denied',
        requestId: req.id,
        metadata: { method: req.method, route: req.routeOptions.url },
      });
      throw Errors.forbiddenOrg();
    }
    if (roles && !roles.includes(access.role)) {
      await recordAudit(db, {
        actor,
        organizationId: access.organizationId,
        action: 'authz.role_denied',
        outcome: 'denied',
        requestId: req.id,
        metadata: { method: req.method, route: req.routeOptions.url, role: access.role, required: roles },
      });
      throw Errors.forbiddenRole();
    }
    req.scoped = {
      db,
      actor,
      organizationId: access.organizationId,
      role: access.role,
      timeZone: access.timeZone,
      requestId: req.id,
    };
  });
});
