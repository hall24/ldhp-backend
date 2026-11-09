import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { scopedOf } from '../auth/plugin.js';
import type { Db } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import { listMemberships } from '../services/access.js';
import { createCustomer, getCustomer, listCustomers, toCustomerDto } from '../services/customers.js';
import {
  createServiceRecord,
  listDue,
  listServiceHistory,
  toServiceRecordDto,
} from '../services/service-records.js';
import { withIdempotency } from '../services/idempotency.js';
import { Errors } from '../lib/errors.js';
import { isValidIsoDate } from '../lib/dates.js';
import {
  AuditEvent,
  Customer,
  CustomerCreate,
  DueItem,
  errorResponses,
  IdempotencyHeader,
  OrgHeader,
  Page,
  ServiceRecord,
  ServiceRecordCreate,
} from './schemas.js';
import { workspaceRoutes } from './workspace.js';
import { teamRoutes } from './team.js';

const secured = [{ bearerAuth: [] }];

export const v1Routes: FastifyPluginAsyncTypebox<{ db: Db }> = async (app, { db }) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness check',
        response: { 200: Type.Object({ status: Type.Literal('ok') }) },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/health/db',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness check: round trip to Postgres',
        response: {
          200: Type.Object({
            status: Type.Literal('ok'),
            database: Type.Literal('ok'),
            latency_ms: Type.Number(),
          }),
          503: Type.Object({ status: Type.Literal('unavailable'), database: Type.Literal('error') }),
        },
      },
    },
    async (req, reply) => {
      const started = performance.now();
      try {
        await db.execute(sql`select 1`);
      } catch (err) {
        req.log.error({ err }, 'database readiness check failed');
        return reply.code(503).send({ status: 'unavailable' as const, database: 'error' as const });
      }
      return {
        status: 'ok' as const,
        database: 'ok' as const,
        latency_ms: Math.round(performance.now() - started),
      };
    },
  );

  app.get(
    '/me',
    {
      onRequest: app.authenticate,
      schema: {
        tags: ['identity'],
        summary: 'Current account and the organizations it can act in',
        security: secured,
        response: {
          200: Type.Object({
            account_id: Type.String(),
            memberships: Type.Array(
              Type.Object({
                organization_id: Type.String(),
                organization_name: Type.String(),
                role: Type.String(),
              }),
            ),
          }),
          401: errorResponses[401],
        },
      },
    },
    async (req) => {
      const rows = await listMemberships(db, req.accountId!);
      return {
        account_id: req.accountId!,
        memberships: rows.map((m) => ({
          organization_id: m.organizationId,
          organization_name: m.organizationName,
          role: m.role,
        })),
      };
    },
  );

  // ---------------------------------------------------------------- customers
  app.get(
    '/customers',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['customers'],
        summary: 'List customers in the organization',
        security: secured,
        headers: OrgHeader,
        querystring: Type.Object({
          limit: Type.Integer({ minimum: 1, maximum: 100, default: 25 }),
          cursor: Type.Optional(Type.String()),
        }),
        response: { 200: Page(Customer), ...errorResponses },
      },
    },
    async (req) => {
      const page = await listCustomers(scopedOf(req), { limit: req.query.limit, cursor: req.query.cursor });
      return { data: page.data.map(toCustomerDto), next_cursor: page.nextCursor };
    },
  );

  app.post(
    '/customers',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['customers'],
        summary: 'Create a customer',
        security: secured,
        headers: IdempotencyHeader,
        body: CustomerCreate,
        response: { 201: Customer, ...errorResponses, 409: errorResponses[400], 422: errorResponses[400] },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const result = await withIdempotency(scopedOf(req), req.headers['idempotency-key'], b, async (ctx) => {
        const row = await createCustomer(ctx, {
          displayName: b.display_name,
          email: b.email ?? null,
          phone: b.phone ?? null,
          addressLine1: b.address?.line1 ?? null,
          addressLine2: b.address?.line2 ?? null,
          city: b.address?.city ?? null,
          region: b.address?.region ?? null,
          postalCode: b.address?.postal_code ?? null,
          notes: b.notes ?? null,
        });
        return { status: 201, body: toCustomerDto(row) };
      });
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(result.status).send(result.body as never);
    },
  );

  const CustomerParams = Type.Object({ customerId: Type.String({ format: 'uuid' }) });

  app.get(
    '/customers/:customerId',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['customers'],
        summary: 'Get a customer',
        security: secured,
        headers: OrgHeader,
        params: CustomerParams,
        response: { 200: Customer, ...errorResponses },
      },
    },
    async (req) => {
      const c = await getCustomer(scopedOf(req), req.params.customerId);
      if (!c) throw Errors.notFound('Customer');
      return toCustomerDto(c);
    },
  );

  // ---------------------------------------------------------- service records
  app.get(
    '/customers/:customerId/service-records',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['service-records'],
        summary: "List a customer's service history (newest first)",
        security: secured,
        headers: OrgHeader,
        params: CustomerParams,
        response: { 200: Type.Object({ data: Type.Array(ServiceRecord) }), ...errorResponses },
      },
    },
    async (req) => {
      const h = await listServiceHistory(scopedOf(req), req.params.customerId);
      if (!h) throw Errors.notFound('Customer');
      return { data: h.records.map(toServiceRecordDto) };
    },
  );

  app.post(
    '/customers/:customerId/service-records',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['service-records'],
        summary: 'Record a completed service',
        description: 'If interval_days is set, next_due_on = completed_on + interval_days.',
        security: secured,
        headers: IdempotencyHeader,
        params: CustomerParams,
        body: ServiceRecordCreate,
        response: { 201: ServiceRecord, ...errorResponses, 409: errorResponses[400], 422: errorResponses[400] },
      },
    },
    async (req, reply) => {
      const b = req.body;
      if (!isValidIsoDate(b.completed_on)) throw Errors.validation({ completed_on: 'invalid date' });
      const result = await withIdempotency(
        scopedOf(req),
        req.headers['idempotency-key'],
        { customerId: req.params.customerId, ...b },
        async (ctx) => {
          const row = await createServiceRecord(ctx, req.params.customerId, {
            serviceType: b.service_type,
            completedOn: b.completed_on,
            intervalDays: b.interval_days ?? null,
            notes: b.notes ?? null,
          });
          return { status: 201, body: toServiceRecordDto(row) };
        },
      );
      if (result.replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(result.status).send(result.body as never);
    },
  );

  // ---------------------------------------------------------------- due queue
  app.get(
    '/due-queue',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['due-queue'],
        summary: 'Customers due or overdue for repeat service',
        description: "Computed in the organization's time zone. Suppressed customers are excluded.",
        security: secured,
        headers: OrgHeader,
        querystring: Type.Object({
          within_days: Type.Integer({ minimum: 0, maximum: 365, default: 30 }),
        }),
        response: { 200: Type.Object({ data: Type.Array(DueItem) }), ...errorResponses },
      },
    },
    async (req) => ({ data: await listDue(scopedOf(req), { withinDays: req.query.within_days }) }),
  );

  // -------------------------------------------------------------------- audit
  app.get(
    '/audit-events',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['audit'],
        summary: 'Audit trail for the organization (owners only)',
        security: secured,
        headers: OrgHeader,
        querystring: Type.Object({
          limit: Type.Integer({ minimum: 1, maximum: 200, default: 50 }),
          before_id: Type.Optional(Type.Integer({ minimum: 1 })),
        }),
        response: { 200: Type.Object({ data: Type.Array(AuditEvent) }), ...errorResponses },
      },
    },
    async (req) => {
      const ctx = scopedOf(req);
      const rows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.organizationId, ctx.organizationId),
            req.query.before_id ? lt(auditEvents.id, req.query.before_id) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.id))
        .limit(req.query.limit);
      return {
        data: rows.map((r) => ({
          id: r.id,
          occurred_at: r.occurredAt.toISOString(),
          actor_type: r.actorType,
          actor_account_id: r.actorAccountId,
          actor_label: r.actorLabel,
          action: r.action,
          outcome: r.outcome,
          record_type: r.recordType,
          record_id: r.recordId,
          request_id: r.requestId,
        })),
      };
    },
  );

  await app.register(workspaceRoutes, { db });
  await app.register(teamRoutes, { db });
};
