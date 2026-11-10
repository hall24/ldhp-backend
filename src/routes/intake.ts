/** Consent records, intake requests (staff side) and the customer response link (public). */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { scopedOf } from '../auth/plugin.js';
import type { Db } from '../db/client.js';
import { listConsents, recordConsent, toConsentDto, withdrawConsent } from '../services/consent.js';
import {
  createIntakeRequest,
  getIntakeRequest,
  listIntakeRequests,
  respondByToken,
  revokeIntakeLink,
  STAFF_STATUSES,
  toIntakeDto,
  updateIntakeStatus,
  viewByToken,
} from '../services/intake.js';
import { Errors } from '../lib/errors.js';
import {
  Consent,
  ConsentCreate,
  ErrorResponse,
  errorResponses,
  IntakeEvent,
  IntakeRequest,
  IntakeResponseSchema,
  Nullable,
  OrgHeader,
  Page,
} from './schemas.js';

const secured = [{ bearerAuth: [] }];
const CustomerParams = Type.Object({ customerId: Type.String({ format: 'uuid' }) });
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

export const intakeRoutes: FastifyPluginAsyncTypebox<{ db: Db }> = async (app, { db }) => {
  // ----------------------------------------------------------------- consent
  app.get(
    '/customers/:customerId/consents',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['consent'],
        summary: "A customer's contact permissions, including withdrawn ones",
        security: secured,
        headers: OrgHeader,
        params: CustomerParams,
        response: { 200: Type.Object({ data: Type.Array(Consent) }), ...errorResponses },
      },
    },
    async (req) => {
      const rows = await listConsents(scopedOf(req), req.params.customerId);
      if (!rows) throw Errors.notFound('Customer');
      return { data: rows.map(toConsentDto) };
    },
  );

  app.post(
    '/customers/:customerId/consents',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['consent'],
        summary: 'Record permission to contact',
        description: 'Stored with channel, contact value, purpose, source and time (PRD §6.5).',
        security: secured,
        headers: OrgHeader,
        params: CustomerParams,
        body: ConsentCreate,
        response: { 201: Consent, ...errorResponses },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const row = await recordConsent(scopedOf(req), req.params.customerId, {
        channel: b.channel,
        purpose: b.purpose,
        contactValue: b.contact_value ?? null,
        source: b.source,
        evidence: b.evidence,
        grantedAt: b.granted_at ? new Date(b.granted_at) : undefined,
      });
      return reply.code(201).send(toConsentDto(row));
    },
  );

  app.post(
    '/customers/:customerId/consents/:consentId/withdraw',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['consent'],
        summary: 'Record an opt-out',
        description: 'Kept as a suppression; blocks future sends to that contact on that channel.',
        security: secured,
        headers: OrgHeader,
        params: Type.Object({
          customerId: Type.String({ format: 'uuid' }),
          consentId: Type.String({ format: 'uuid' }),
        }),
        body: Type.Object(
          { source: Type.String({ minLength: 1, maxLength: 100, description: 'e.g. phone_call, email_reply' }) },
          { additionalProperties: false },
        ),
        response: { 200: Consent, ...errorResponses },
      },
    },
    async (req) =>
      toConsentDto(
        await withdrawConsent(scopedOf(req), req.params.customerId, req.params.consentId, req.body.source),
      ),
  );

  // ------------------------------------------------------------ intake (staff)
  app.post(
    '/customers/:customerId/intake-requests',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['intake'],
        summary: 'Create a customer response link',
        description:
          'Returns link_token once. Build the customer URL with it in the fragment, e.g. ' +
          'https://app.example/r#<token>, never in a query string. Valid for 14 days.',
        security: secured,
        headers: OrgHeader,
        params: CustomerParams,
        body: Type.Object(
          { service_type: Type.Optional(Nullable(Type.String({ maxLength: 100 }))) },
          { additionalProperties: false },
        ),
        response: {
          201: Type.Object({ intake_request: IntakeRequest, link_token: Type.String() }),
          ...errorResponses,
        },
      },
    },
    async (req, reply) => {
      const { request, token } = await createIntakeRequest(scopedOf(req), req.params.customerId, {
        serviceType: req.body.service_type ?? null,
      });
      return reply.code(201).send({ intake_request: toIntakeDto(request), link_token: token });
    },
  );

  app.get(
    '/intake-requests',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['intake'],
        summary: 'The intake queue (newest first)',
        description: 'status=open returns everything not yet scheduled_externally or not_proceeding.',
        security: secured,
        headers: OrgHeader,
        querystring: Type.Object({
          status: Type.Optional(
            Type.Union(
              ['open', 'awaiting_response', 'received', 'contacted', 'scheduled_externally', 'not_proceeding', 'unable_to_reach'].map(
                (s) => Type.Literal(s),
              ),
            ),
          ),
          limit: Type.Integer({ minimum: 1, maximum: 100, default: 25 }),
          cursor: Type.Optional(Type.String()),
        }),
        response: { 200: Page(IntakeRequest), ...errorResponses },
      },
    },
    async (req) => {
      const page = await listIntakeRequests(scopedOf(req), {
        status: req.query.status as never,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      return { data: page.data.map((x) => toIntakeDto(x.r, x.customerName)), next_cursor: page.nextCursor };
    },
  );

  app.get(
    '/intake-requests/:id',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['intake'],
        summary: 'An intake request with its status history',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: {
          200: Type.Intersect([IntakeRequest, Type.Object({ history: Type.Array(IntakeEvent) })]),
          ...errorResponses,
        },
      },
    },
    async (req) => {
      const found = await getIntakeRequest(scopedOf(req), req.params.id);
      if (!found) throw Errors.notFound('Intake request');
      return {
        ...toIntakeDto(found.r, found.customerName),
        history: found.history.map((h) => ({
          from_status: h.fromStatus,
          to_status: h.toStatus,
          actor_type: h.actorType,
          actor_account_id: h.actorAccountId,
          note: h.note,
          occurred_at: h.occurredAt.toISOString(),
        })),
      };
    },
  );

  app.patch(
    '/intake-requests/:id',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['intake'],
        summary: 'Move a request to a new status',
        description:
          'Staff statuses: contacted, scheduled_externally (closed), not_proceeding (closed), unable_to_reach. ' +
          'R1 does not book appointments; scheduled_externally means staff arranged it in their own system.',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        body: Type.Object(
          {
            status: Type.Union(STAFF_STATUSES.map((s) => Type.Literal(s))),
            note: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
          },
          { additionalProperties: false },
        ),
        response: { 200: IntakeRequest, ...errorResponses, 409: ErrorResponse },
      },
    },
    async (req) =>
      toIntakeDto(await updateIntakeStatus(scopedOf(req), req.params.id, req.body.status, req.body.note ?? null)),
  );

  app.post(
    '/intake-requests/:id/revoke-link',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['intake'],
        summary: 'Revoke the customer link (the request itself stays)',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: { 200: IntakeRequest, ...errorResponses },
      },
    },
    async (req) => toIntakeDto(await revokeIntakeLink(scopedOf(req), req.params.id)),
  );

  // ------------------------------------------------------ customer link (public)
  const TokenBody = Type.Object({ token: Type.String({ maxLength: 200 }) }, { additionalProperties: false });

  app.post(
    '/public/intake/view',
    {
      schema: {
        tags: ['customer-link'],
        summary: 'What the customer sees when they open their link (no account needed)',
        description:
          'The token goes in the body, never the URL. Invalid, expired and revoked links all return 404 link_invalid.',
        body: TokenBody,
        response: {
          200: Type.Object({
            business_name: Type.String(),
            service_type: Nullable(Type.String()),
            can_respond: Type.Boolean(),
            response: Nullable(IntakeResponseSchema),
            expires_at: Type.String({ format: 'date-time' }),
          }),
          400: ErrorResponse,
          404: ErrorResponse,
        },
      },
    },
    async (req) => viewByToken(db, req.body.token),
  );

  app.post(
    '/public/intake/respond',
    {
      schema: {
        tags: ['customer-link'],
        summary: 'Customer answers: request service, decline, or ask to be contacted',
        description:
          'Can be changed until staff start following up (then 409 already_handled). ' +
          'unsubscribe=true stops future emails from this business to this customer.',
        body: Type.Object(
          {
            token: Type.String({ maxLength: 200 }),
            response: IntakeResponseSchema,
            note: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
            unsubscribe: Type.Optional(Type.Boolean({ default: false })),
          },
          { additionalProperties: false },
        ),
        response: {
          200: Type.Object({ business_name: Type.String(), response: IntakeResponseSchema }),
          400: ErrorResponse,
          404: ErrorResponse,
          409: ErrorResponse,
        },
      },
    },
    async (req) =>
      respondByToken(
        db,
        req.body.token,
        { response: req.body.response, note: req.body.note ?? null, unsubscribe: req.body.unsubscribe ?? false },
        req.id,
      ),
  );
};
