/**
 * Workspace setup and record editing (PRD §4 steps 1-4): create a workspace,
 * manage its settings, edit or suppress customers, and correct service records.
 */
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { scopedOf } from '../auth/plugin.js';
import type { Db } from '../db/client.js';
import {
  createOrganization,
  getOrganization,
  toOrganizationDto,
  updateOrganization,
  type OrganizationSettings,
} from '../services/organizations.js';
import { deleteCustomer, toCustomerDto, updateCustomer, type CustomerPatch } from '../services/customers.js';
import {
  deleteServiceRecord,
  toServiceRecordDto,
  updateServiceRecord,
  type ServiceRecordPatch,
} from '../services/service-records.js';
import { Errors } from '../lib/errors.js';
import { isValidIsoDate } from '../lib/dates.js';
import {
  Customer,
  CustomerUpdate,
  errorResponses,
  Organization,
  OrganizationCreate,
  OrganizationUpdate,
  OrgHeader,
  ServiceRecord,
  ServiceRecordUpdate,
} from './schemas.js';

const secured = [{ bearerAuth: [] }];

type SettingsBody = {
  name?: string;
  time_zone?: string;
  message_from_name?: string | null;
  service_types?: string[];
  service_area?: string | null;
  reply_to_email?: string | null;
  mailing_address?: string | null;
  booking_url?: string | null;
  job_values_cents?: Record<string, number>;
};

function toSettings(b: SettingsBody): OrganizationSettings {
  const s: OrganizationSettings = {};
  if (b.name !== undefined) s.name = b.name;
  if (b.time_zone !== undefined) s.timeZone = b.time_zone;
  if (b.message_from_name !== undefined) s.messageFromName = b.message_from_name;
  if (b.service_types !== undefined) s.serviceTypes = b.service_types;
  if (b.service_area !== undefined) s.serviceArea = b.service_area;
  if (b.reply_to_email !== undefined) s.replyToEmail = b.reply_to_email;
  if (b.mailing_address !== undefined) s.mailingAddress = b.mailing_address;
  if (b.booking_url !== undefined) s.bookingUrl = b.booking_url;
  if (b.job_values_cents !== undefined) s.jobValuesCents = b.job_values_cents;
  return s;
}

export const workspaceRoutes: FastifyPluginAsyncTypebox<{ db: Db }> = async (app, { db }) => {
  // ------------------------------------------------------------- organizations
  app.post(
    '/organizations',
    {
      onRequest: app.authenticate,
      schema: {
        tags: ['organization'],
        summary: 'Create a workspace (the caller becomes its owner)',
        description:
          'Self-serve setup. No X-Organization-Id needed. Send an Idempotency-Key so a retried signup ' +
          'returns the same workspace instead of creating a second one.',
        security: secured,
        headers: Type.Object({ 'idempotency-key': Type.Optional(Type.String({ maxLength: 200 })) }),
        body: OrganizationCreate,
        response: { 201: Organization, 400: errorResponses[400], 401: errorResponses[401] },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const { org, replayed } = await createOrganization(
        db,
        { type: 'user', accountId: req.accountId! },
        { ...toSettings(b), name: b.name },
        { requestId: req.id, idempotencyKey: req.headers['idempotency-key'] },
      );
      if (replayed) reply.header('idempotent-replayed', 'true');
      return reply.code(201).send(toOrganizationDto(org, 'owner') as never);
    },
  );

  app.get(
    '/organization',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['organization'],
        summary: 'The selected workspace and its settings',
        security: secured,
        headers: OrgHeader,
        response: { 200: Organization, ...errorResponses },
      },
    },
    async (req) => {
      const ctx = scopedOf(req);
      return toOrganizationDto(await getOrganization(ctx), ctx.role) as never;
    },
  );

  app.patch(
    '/organization',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['organization'],
        summary: 'Update workspace settings (owners only)',
        security: secured,
        headers: OrgHeader,
        body: OrganizationUpdate,
        response: { 200: Organization, ...errorResponses },
      },
    },
    async (req) => {
      const ctx = scopedOf(req);
      return toOrganizationDto(await updateOrganization(ctx, toSettings(req.body)), ctx.role) as never;
    },
  );

  // ----------------------------------------------------------------- customers
  const CustomerParams = Type.Object({ customerId: Type.String({ format: 'uuid' }) });

  app.patch(
    '/customers/:customerId',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['customers'],
        summary: 'Edit a customer, or suppress them from the due queue',
        description: 'Only the fields you send are changed. Send null to clear an optional field.',
        security: secured,
        headers: OrgHeader,
        params: CustomerParams,
        body: CustomerUpdate,
        response: { 200: Customer, ...errorResponses },
      },
    },
    async (req) => {
      const b = req.body;
      const patch: CustomerPatch = {};
      if (b.display_name !== undefined) patch.displayName = b.display_name;
      if (b.email !== undefined) patch.email = b.email;
      if (b.phone !== undefined) patch.phone = b.phone;
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.suppressed !== undefined) patch.suppressed = b.suppressed;
      if (b.address) {
        if (b.address.line1 !== undefined) patch.addressLine1 = b.address.line1;
        if (b.address.line2 !== undefined) patch.addressLine2 = b.address.line2;
        if (b.address.city !== undefined) patch.city = b.address.city;
        if (b.address.region !== undefined) patch.region = b.address.region;
        if (b.address.postal_code !== undefined) patch.postalCode = b.address.postal_code;
      }
      if (Object.keys(patch).length === 0) throw Errors.validation({ body: 'no changes' });
      const row = await updateCustomer(scopedOf(req), req.params.customerId, patch);
      if (!row) throw Errors.notFound('Customer');
      return toCustomerDto(row);
    },
  );

  app.delete(
    '/customers/:customerId',
    {
      onRequest: app.requireOrg(['owner']),
      schema: {
        tags: ['customers'],
        summary: 'Delete a customer (owners only)',
        description:
          'Removes the customer from lists and the due queue. History is retained per the retention policy.',
        security: secured,
        headers: OrgHeader,
        params: CustomerParams,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      if (!(await deleteCustomer(scopedOf(req), req.params.customerId))) throw Errors.notFound('Customer');
      return reply.code(204).send(null);
    },
  );

  // ----------------------------------------------------------- service records
  const RecordParams = Type.Object({
    customerId: Type.String({ format: 'uuid' }),
    recordId: Type.String({ format: 'uuid' }),
  });

  app.patch(
    '/customers/:customerId/service-records/:recordId',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['service-records'],
        summary: 'Correct a service record or its due date',
        description:
          'If completed_on or interval_days changes and next_due_on is not sent, next_due_on is recomputed. ' +
          'Send next_due_on to set the due date directly (null removes it from the due queue).',
        security: secured,
        headers: OrgHeader,
        params: RecordParams,
        body: ServiceRecordUpdate,
        response: { 200: ServiceRecord, ...errorResponses },
      },
    },
    async (req) => {
      const b = req.body;
      for (const f of ['completed_on', 'next_due_on'] as const) {
        const v = b[f];
        if (typeof v === 'string' && !isValidIsoDate(v)) throw Errors.validation({ [f]: 'invalid date' });
      }
      const patch: ServiceRecordPatch = {};
      if (b.service_type !== undefined) patch.serviceType = b.service_type;
      if (b.completed_on !== undefined) patch.completedOn = b.completed_on;
      if (b.interval_days !== undefined) patch.intervalDays = b.interval_days;
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.next_due_on !== undefined) patch.nextDueOn = b.next_due_on;
      const row = await updateServiceRecord(scopedOf(req), req.params.customerId, req.params.recordId, patch);
      if (!row) throw Errors.notFound('Service record');
      return toServiceRecordDto(row);
    },
  );

  app.delete(
    '/customers/:customerId/service-records/:recordId',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['service-records'],
        summary: 'Delete a service record entered in error',
        security: secured,
        headers: OrgHeader,
        params: RecordParams,
        response: { 204: Type.Null(), ...errorResponses },
      },
    },
    async (req, reply) => {
      const ok = await deleteServiceRecord(scopedOf(req), req.params.customerId, req.params.recordId);
      if (!ok) throw Errors.notFound('Service record');
      return reply.code(204).send(null);
    },
  );
};
