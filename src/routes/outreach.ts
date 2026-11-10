/** Email campaigns (staff) and the unsubscribe link (public). */
import type { FastifyPluginAsyncTypebox, TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { scopedOf } from '../auth/plugin.js';
import type { Db } from '../db/client.js';
import {
  cancelCampaign,
  createCampaign,
  getCampaign,
  listCampaignMessages,
  listCampaigns,
  type OutreachEnv,
  previewCampaign,
  sendCampaign,
  toCampaignDto,
  unsubscribeByToken,
  updateCampaign,
} from '../services/outreach.js';
import { Errors } from '../lib/errors.js';
import {
  Campaign,
  CampaignCreate,
  CampaignPreview,
  CampaignUpdate,
  ErrorResponse,
  errorResponses,
  OrgHeader,
  OutreachMessage,
  Page,
} from './schemas.js';

const secured = [{ bearerAuth: [] }];
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
const withConflict = { ...errorResponses, 409: ErrorResponse };

export const outreachRoutes: FastifyPluginAsyncTypebox<{ db: Db; outreach: OutreachEnv }> = async (
  app,
  { db, outreach },
) => {
  app.post(
    '/campaigns',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['outreach'],
        summary: 'Draft an email campaign',
        description:
          'Pick customers (e.g. from the due queue), write the message, then preview and send. ' +
          'Email only in this release (channel sms returns 400 channel_unavailable). At most 200 customers.',
        security: secured,
        headers: OrgHeader,
        body: CampaignCreate,
        response: { 201: Campaign, ...errorResponses },
      },
    },
    async (req, reply) => {
      const b = req.body;
      const row = await createCampaign(scopedOf(req), {
        name: b.name,
        channel: b.channel ?? 'email',
        purpose: b.purpose ?? 'service_reminders',
        serviceType: b.service_type ?? null,
        subject: b.subject,
        body: b.body,
        customerIds: b.customer_ids,
      });
      return reply.code(201).send(toCampaignDto(row));
    },
  );

  app.get(
    '/campaigns',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['outreach'],
        summary: 'Campaigns, newest first',
        security: secured,
        headers: OrgHeader,
        querystring: Type.Object({
          limit: Type.Integer({ minimum: 1, maximum: 100, default: 25 }),
          cursor: Type.Optional(Type.String()),
        }),
        response: { 200: Page(Campaign), ...errorResponses },
      },
    },
    async (req) => {
      const page = await listCampaigns(scopedOf(req), { limit: req.query.limit, cursor: req.query.cursor });
      return { data: page.data.map((x) => toCampaignDto(x.campaign, x.results)), next_cursor: page.nextCursor };
    },
  );

  app.get(
    '/campaigns/:id',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['outreach'],
        summary: 'A campaign and, once sent, its results',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: { 200: Campaign, ...errorResponses },
      },
    },
    async (req) => {
      const found = await getCampaign(scopedOf(req), req.params.id);
      if (!found) throw Errors.notFound('Campaign');
      return toCampaignDto(found.campaign, found.results);
    },
  );

  app.patch(
    '/campaigns/:id',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['outreach'],
        summary: 'Edit a draft campaign',
        description: 'Only drafts can be edited (409 campaign_not_draft).',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        body: CampaignUpdate,
        response: { 200: Campaign, ...withConflict },
      },
    },
    async (req) => {
      const b = req.body;
      const row = await updateCampaign(scopedOf(req), req.params.id, {
        name: b.name,
        purpose: b.purpose,
        serviceType: b.service_type,
        subject: b.subject,
        body: b.body,
        customerIds: b.customer_ids,
      });
      return toCampaignDto(row);
    },
  );

  app.post(
    '/campaigns/:id/cancel',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['outreach'],
        summary: 'Cancel a draft campaign',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: { 200: Campaign, ...withConflict },
      },
    },
    async (req) => toCampaignDto(await cancelCampaign(scopedOf(req), req.params.id)),
  );

  app.get(
    '/campaigns/:id/preview',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['outreach'],
        summary: 'Who will get it, who will be skipped and why, and a sample email',
        description:
          'Eligibility is checked again for every customer at the moment of sending, so the result can ' +
          'change if someone opts out in between.',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: { 200: CampaignPreview, ...errorResponses },
      },
    },
    async (req) => previewCampaign(scopedOf(req), req.params.id, outreach),
  );

  app.post(
    '/campaigns/:id/send',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['outreach'],
        summary: 'Approve and send the campaign now',
        description:
          'Records who approved it. Each customer is checked for opt-out and consent immediately before ' +
          'their email is sent. Calling again never sends twice: a sent campaign returns its results, ' +
          'one being sent returns 409 send_in_progress, and an interrupted send resumes with the customers ' +
          'not yet handled. 409 sender_incomplete: add a mailing address in Settings. ' +
          '503 email_not_configured: email is not set up for this environment.',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: { 200: Campaign, ...withConflict, 502: ErrorResponse, 503: ErrorResponse },
      },
    },
    async (req) => {
      const r = await sendCampaign(scopedOf(req), req.params.id, outreach);
      return toCampaignDto(r.campaign, r.results);
    },
  );

  app.get(
    '/campaigns/:id/messages',
    {
      onRequest: app.requireOrg(),
      schema: {
        tags: ['outreach'],
        summary: 'Per-customer send results',
        security: secured,
        headers: OrgHeader,
        params: IdParams,
        response: { 200: Type.Object({ data: Type.Array(OutreachMessage) }), ...errorResponses },
      },
    },
    async (req) => {
      const rows = await listCampaignMessages(scopedOf(req), req.params.id);
      if (!rows) throw Errors.notFound('Campaign');
      return {
        data: rows.map(({ m, customerName, intakeRequestId }) => ({
          id: m.id,
          customer_id: m.customerId,
          customer_name: customerName,
          recipient: m.recipient,
          status: m.status,
          suppression_reason: m.suppressionReason as never,
          failure_code:
            m.status === 'failed' ? (((m.providerResult as { code?: string; error?: string } | null)?.code ??
              (m.providerResult as { error?: string } | null)?.error) ?? 'unknown') : null,
          template_version: m.templateVersion,
          consent_record_id: m.consentRecordId,
          intake_request_id: intakeRequestId,
          sent_at: m.sentAt?.toISOString() ?? null,
          created_at: m.createdAt.toISOString(),
        })),
      };
    },
  );

  // ------------------------------------------------------------- unsubscribe
  app.post(
    '/public/unsubscribe',
    {
      schema: {
        tags: ['customer-link'],
        summary: 'Unsubscribe from a business’s emails (the page linked in every email footer)',
        description:
          'No account needed. The front-end page at /unsubscribe reads the token from the URL fragment ' +
          'and posts it here. Stops all future email from that business to that address. Idempotent.',
        body: Type.Object({ token: Type.String({ maxLength: 200 }) }, { additionalProperties: false }),
        response: { 200: Type.Object({ business_name: Type.String() }), 400: ErrorResponse, 404: ErrorResponse },
      },
    },
    async (req) => unsubscribeByToken(db, req.body.token, 'unsubscribe_link', req.id),
  );

  // RFC 8058 one-click unsubscribe: mail apps POST "List-Unsubscribe=One-Click" as a form.
  await app.register(async (scope) => {
    const oneClick = scope.withTypeProvider<TypeBoxTypeProvider>();
    oneClick.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_req, body, done) => done(null, body),
    );
    oneClick.post(
      '/public/unsubscribe/:token',
      {
        schema: {
          tags: ['customer-link'],
          summary: 'One-click unsubscribe used by mail apps (List-Unsubscribe header)',
          description: 'Not for front ends. Same effect as POST /v1/public/unsubscribe.',
          params: Type.Object({ token: Type.String({ maxLength: 200 }) }),
          response: { 200: Type.Object({ status: Type.Literal('unsubscribed') }), 404: ErrorResponse },
        },
      },
      async (req) => {
        await unsubscribeByToken(db, req.params.token, 'list_unsubscribe_one_click', req.id);
        return { status: 'unsubscribed' as const };
      },
    );
  });
};
