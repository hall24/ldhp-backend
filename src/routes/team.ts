/** Team management: invite links, member list, role changes and revocation (PRD §3, §8). */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { scopedOf } from '../auth/plugin.js';
import type { Db } from '../db/client.js';
import {
  acceptInvitation,
  changeMemberRole,
  createInvitation,
  listInvitations,
  listMembers,
  revokeInvitation,
  revokeMember,
  toInvitationDto,
} from '../services/team.js';
import { Errors } from '../lib/errors.js';
import {
  errorResponses,
  ErrorResponse,
  Invitation,
  InvitationCreate,
  InvitationCreated,
  Member,
  OrgHeader,
} from './schemas.js';

const secured = [{ bearerAuth: [] }];
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const teamRoutes: FastifyPluginAsyncTypebox<{ db: Db }> = async (app, { db }) => {
  app.post(
    '/invitations',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['team'],
        summary: 'Create an invite link (owners only)',
        description: 'Valid for 7 days, single use, revocable. Default role is staff.',
        security: secured,
        headers: OrgHeader,
        body: InvitationCreate,
        response: { 201: InvitationCreated, ...errorResponses, 409: ErrorResponse },
      },
    },
    async (req, reply) => {
      const { invitation, token } = await createInvitation(scopedOf(req), {
        role: req.body.role ?? 'staff',
        email: req.body.email ?? null,
      });
      return reply.code(201).send({ invitation: toInvitationDto(invitation), invite_token: token });
    },
  );

  app.get(
    '/invitations',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['team'],
        summary: 'Pending invitations (owners only)',
        security: secured,
        headers: OrgHeader,
        response: { 200: Type.Object({ data: Type.Array(Invitation) }), ...errorResponses },
      },
    },
    async (req) => ({ data: (await listInvitations(scopedOf(req))).map(toInvitationDto) }),
  );

  app.delete(
    '/invitations/:id',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['team'],
        summary: 'Revoke a pending invitation (owners only)',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      if (!(await revokeInvitation(scopedOf(req), req.params.id))) throw Errors.notFound('Invitation');
      return reply.code(204).send(null);
    },
  );

  app.post(
    '/invitations/accept',
    {
      onRequest: app.authenticate,
      schema: {
        tags: ['team'],
        summary: 'Join a workspace with an invite token',
        description:
          'No X-Organization-Id needed. Unknown, expired, revoked and used tokens all return 404 invitation_invalid.',
        security: secured,
        body: Type.Object({ token: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
        response: {
          200: Type.Object({
            organization_id: Type.String({ format: 'uuid' }),
            organization_name: Type.String(),
            role: Type.String(),
          }),
          400: ErrorResponse,
          401: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req) => {
      const r = await acceptInvitation(db, { type: 'user', accountId: req.accountId! }, req.body.token, req.id);
      return { organization_id: r.organizationId, organization_name: r.organizationName, role: r.role };
    },
  );

  app.get(
    '/members',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['team'],
        summary: 'Active members of the workspace',
        security: secured,
        headers: OrgHeader,
        response: { 200: Type.Object({ data: Type.Array(Member) }), ...errorResponses },
      },
    },
    async (req) => ({
      data: (await listMembers(scopedOf(req))).map((m) => ({
        id: m.id,
        account_id: m.accountId,
        display_name: m.displayName,
        email: m.email,
        role: m.role,
        joined_at: m.createdAt.toISOString(),
      })),
    }),
  );

  app.patch(
    '/members/:id',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['team'],
        summary: "Change a member's role (owners only)",
        description: 'The last owner cannot be demoted (409 last_owner).',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        body: Type.Object(
          { role: Type.Union([Type.Literal('owner'), Type.Literal('staff')]) },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ id: Type.String(), role: Type.String() }),
          ...errorResponses,
          409: ErrorResponse,
        },
      },
    },
    async (req) => {
      const m = await changeMemberRole(scopedOf(req), req.params.id, req.body.role);
      return { id: m.id, role: m.role };
    },
  );

  app.delete(
    '/members/:id',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['team'],
        summary: "Remove a member's access (owners only)",
        description: 'Takes effect on their next request. The last owner cannot be removed (409 last_owner).',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: { 204: Type.Null(), ...errorResponses, 409: ErrorResponse },
      },
    },
    async (req, reply) => {
      await revokeMember(scopedOf(req), req.params.id);
      return reply.code(204).send(null);
    },
  );
};
