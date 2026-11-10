import { Type, type TSchema } from '@sinclair/typebox';

export const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);

export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      request_id: Type.String(),
      details: Type.Optional(Type.Unknown()),
    }),
  },
  { title: 'Error' },
);

export const Address = Type.Object({
  line1: Nullable(Type.String()),
  line2: Nullable(Type.String()),
  city: Nullable(Type.String()),
  region: Nullable(Type.String()),
  postal_code: Nullable(Type.String()),
});

export const Customer = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    display_name: Type.String(),
    email: Nullable(Type.String()),
    phone: Nullable(Type.String()),
    address: Address,
    suppressed: Type.Boolean(),
    notes: Nullable(Type.String()),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
  },
  { title: 'Customer' },
);

const optStr = (max: number) => Type.Optional(Nullable(Type.String({ maxLength: max })));
const optEmail = Type.Optional(Nullable(Type.String({ format: 'email', maxLength: 320 })));

export const CustomerCreate = Type.Object(
  {
    display_name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.Optional(Nullable(Type.String({ format: 'email', maxLength: 320 }))),
    phone: optStr(40),
    address: Type.Optional(
      Type.Object(
        {
          line1: optStr(200),
          line2: optStr(200),
          city: optStr(100),
          region: optStr(100),
          postal_code: optStr(20),
        },
        { additionalProperties: false },
      ),
    ),
    notes: optStr(5000),
  },
  { title: 'CustomerCreate', additionalProperties: false },
);

export const CustomerUpdate = Type.Object(
  {
    display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    email: Type.Optional(Nullable(Type.String({ format: 'email', maxLength: 320 }))),
    phone: optStr(40),
    address: Type.Optional(
      Type.Object(
        {
          line1: optStr(200),
          line2: optStr(200),
          city: optStr(100),
          region: optStr(100),
          postal_code: optStr(20),
        },
        { additionalProperties: false },
      ),
    ),
    notes: optStr(5000),
    suppressed: Type.Optional(
      Type.Boolean({ description: 'Suppressed customers are left out of the due queue.' }),
    ),
  },
  { title: 'CustomerUpdate', additionalProperties: false, minProperties: 1 },
);

const bookingUrlDesc =
  "The business's own online booking page (https only), e.g. a Jobber, Housecall Pro or Calendly link. " +
  'Shown to customers on the response page so a "yes" can pick a time right away.';
const jobValuesDesc =
  'Typical job value per service type, in US cents (e.g. {"gutter_cleaning": 25000}). ' +
  'Optional; only used for the due-queue revenue estimate. Replaces the whole map when sent.';
const optBookingUrl = Type.Optional(Nullable(Type.String({ format: 'uri', maxLength: 500, description: bookingUrlDesc })));
const optJobValues = Type.Optional(
  Type.Record(Type.String({ minLength: 1, maxLength: 100 }), Type.Integer({ minimum: 0, maximum: 100_000_000 }), {
    maxProperties: 50,
    description: jobValuesDesc,
  }),
);

const serviceTypeList = Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 50 });

export const Organization = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    time_zone: Type.String({ description: 'IANA time zone; the due queue is computed in it.' }),
    message_from_name: Nullable(Type.String()),
    service_types: Type.Array(Type.String()),
    service_area: Nullable(Type.String()),
    reply_to_email: Nullable(Type.String({ description: 'Customer replies to outreach email go here.' })),
    mailing_address: Nullable(
      Type.String({ description: 'Printed in every outreach email footer. Required before sending email.' }),
    ),
    booking_url: Nullable(Type.String({ description: bookingUrlDesc })),
    job_values_cents: Type.Record(Type.String(), Type.Integer(), { description: jobValuesDesc }),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
    role: Type.Union([Type.Literal('owner'), Type.Literal('staff')], {
      description: "The caller's role in this organization.",
    }),
  },
  { title: 'Organization' },
);

export const OrganizationCreate = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    time_zone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    message_from_name: optStr(200),
    service_types: Type.Optional(serviceTypeList),
    service_area: optStr(500),
    reply_to_email: optEmail,
    mailing_address: optStr(500),
    booking_url: optBookingUrl,
    job_values_cents: optJobValues,
  },
  { title: 'OrganizationCreate', additionalProperties: false },
);

export const OrganizationUpdate = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    time_zone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    message_from_name: optStr(200),
    service_types: Type.Optional(serviceTypeList),
    service_area: optStr(500),
    reply_to_email: optEmail,
    mailing_address: optStr(500),
    booking_url: optBookingUrl,
    job_values_cents: optJobValues,
  },
  { title: 'OrganizationUpdate', additionalProperties: false, minProperties: 1 },
);

export const ServiceRecord = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    customer_id: Type.String({ format: 'uuid' }),
    service_type: Type.String(),
    completed_on: Type.String({ format: 'date' }),
    interval_days: Nullable(Type.Integer()),
    next_due_on: Nullable(Type.String({ format: 'date' })),
    notes: Nullable(Type.String()),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
  },
  { title: 'ServiceRecord' },
);

export const ServiceRecordCreate = Type.Object(
  {
    service_type: Type.String({ minLength: 1, maxLength: 100 }),
    completed_on: Type.String({ format: 'date' }),
    interval_days: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 3650 }))),
    notes: optStr(5000),
  },
  { title: 'ServiceRecordCreate', additionalProperties: false },
);

export const ServiceRecordUpdate = Type.Object(
  {
    service_type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    completed_on: Type.Optional(Type.String({ format: 'date' })),
    interval_days: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 3650 }))),
    notes: optStr(5000),
    next_due_on: Type.Optional(
      Nullable(
        Type.String({
          format: 'date',
          description:
            'Set the due date directly. If omitted and completed_on or interval_days changes, it is recomputed.',
        }),
      ),
    ),
  },
  { title: 'ServiceRecordUpdate', additionalProperties: false, minProperties: 1 },
);

export const DueItem = Type.Object(
  {
    service_record_id: Type.String({ format: 'uuid' }),
    customer_id: Type.String({ format: 'uuid' }),
    customer_name: Type.String(),
    service_type: Type.String(),
    last_completed_on: Type.String({ format: 'date' }),
    next_due_on: Type.String({ format: 'date' }),
    days_until_due: Type.Integer(),
    status: Type.Union([Type.Literal('overdue'), Type.Literal('due_soon')]),
    estimated_value_cents: Nullable(
      Type.Integer({ description: "The workspace's typical job value for this service type, if set (US cents)." }),
    ),
  },
  { title: 'DueItem' },
);

export const DueSummary = Type.Object(
  {
    overdue: Type.Integer(),
    due_soon: Type.Integer(),
    estimated_value_cents: Nullable(
      Type.Integer({
        description:
          'Sum of typical job values for the items listed (US cents). Null when no job values are set. ' +
          'An estimate: show it labelled as such ("About $3,200 in rebookings waiting").',
      }),
    ),
    items_without_value: Type.Integer({ description: 'Items whose service type has no job value set.' }),
    currency: Type.Literal('USD'),
  },
  { title: 'DueSummary' },
);

export const AuditEvent = Type.Object(
  {
    id: Type.Integer(),
    occurred_at: Type.String({ format: 'date-time' }),
    actor_type: Type.String(),
    actor_account_id: Nullable(Type.String()),
    actor_label: Nullable(Type.String()),
    action: Type.String(),
    outcome: Type.String(),
    record_type: Nullable(Type.String()),
    record_id: Nullable(Type.String()),
    request_id: Nullable(Type.String()),
  },
  { title: 'AuditEvent' },
);

export const OrgHeader = Type.Object({
  'x-organization-id': Type.String({
    format: 'uuid',
    description: 'Organization (workspace) context. The server verifies your membership.',
  }),
});

export const IdempotencyHeader = Type.Object({
  'x-organization-id': Type.String({ format: 'uuid' }),
  'idempotency-key': Type.Optional(
    Type.String({ maxLength: 200, description: 'Retries with the same key return the original response.' }),
  ),
});

export const errorResponses = {
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
};

export const Page = <T extends TSchema>(item: T) =>
  Type.Object({ data: Type.Array(item), next_cursor: Nullable(Type.String()) });

const RoleSchema = Type.Union([Type.Literal('owner'), Type.Literal('staff')]);

export const Invitation = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    role: RoleSchema,
    email: Nullable(Type.String()),
    status: Type.Union([
      Type.Literal('pending'),
      Type.Literal('accepted'),
      Type.Literal('revoked'),
      Type.Literal('expired'),
    ]),
    expires_at: Type.String({ format: 'date-time' }),
    accepted_at: Nullable(Type.String({ format: 'date-time' })),
    created_at: Type.String({ format: 'date-time' }),
  },
  { title: 'Invitation' },
);

export const InvitationCreate = Type.Object(
  {
    role: Type.Optional(RoleSchema),
    email: Type.Optional(Nullable(Type.String({ format: 'email', maxLength: 320 }))),
  },
  { title: 'InvitationCreate', additionalProperties: false },
);

export const InvitationCreated = Type.Object(
  {
    invitation: Invitation,
    invite_token: Type.String({
      description:
        'Shown once and never stored. Put it in the invite link fragment (e.g. /join#<token>), not a query string.',
    }),
  },
  { title: 'InvitationCreated' },
);

export const Member = Type.Object(
  {
    id: Type.String({ format: 'uuid', description: 'Membership id' }),
    account_id: Type.String({ format: 'uuid' }),
    display_name: Nullable(Type.String()),
    email: Nullable(Type.String()),
    role: RoleSchema,
    joined_at: Type.String({ format: 'date-time' }),
  },
  { title: 'Member' },
);

export const ChannelSchema = Type.Union([Type.Literal('email'), Type.Literal('sms')]);
export const PurposeSchema = Type.Union([Type.Literal('service_reminders'), Type.Literal('marketing')]);

export const Consent = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    customer_id: Type.String({ format: 'uuid' }),
    channel: ChannelSchema,
    contact_value: Type.String(),
    purpose: PurposeSchema,
    source: Type.String(),
    granted_at: Type.String({ format: 'date-time' }),
    withdrawn_at: Nullable(Type.String({ format: 'date-time' })),
    withdrawal_source: Nullable(Type.String()),
    status: Type.Union([Type.Literal('active'), Type.Literal('withdrawn')]),
    created_at: Type.String({ format: 'date-time' }),
  },
  { title: 'Consent' },
);

export const ConsentCreate = Type.Object(
  {
    channel: ChannelSchema,
    purpose: PurposeSchema,
    contact_value: Type.Optional(
      Nullable(Type.String({ maxLength: 320, description: "Defaults to the customer's email or phone." })),
    ),
    source: Type.String({
      minLength: 1,
      maxLength: 100,
      description: 'How permission was given, e.g. paper_form, web_form, verbal_recorded.',
    }),
    evidence: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    granted_at: Type.Optional(Type.String({ format: 'date-time' })),
  },
  { title: 'ConsentCreate', additionalProperties: false },
);

const IntakeStatusSchema = Type.Union(
  ['awaiting_response', 'received', 'contacted', 'scheduled_externally', 'not_proceeding', 'unable_to_reach'].map(
    (s) => Type.Literal(s),
  ),
);
export const IntakeResponseSchema = Type.Union([
  Type.Literal('request_service'),
  Type.Literal('decline'),
  Type.Literal('contact_me'),
]);

export const IntakeRequest = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    customer_id: Type.String({ format: 'uuid' }),
    customer_name: Type.Optional(Type.String()),
    service_type: Nullable(Type.String()),
    status: IntakeStatusSchema,
    response: Nullable(IntakeResponseSchema),
    customer_note: Nullable(Type.String()),
    responded_at: Nullable(Type.String({ format: 'date-time' })),
    link_state: Type.Union([Type.Literal('active'), Type.Literal('expired'), Type.Literal('revoked')]),
    link_expires_at: Type.String({ format: 'date-time' }),
    status_changed_at: Nullable(Type.String({ format: 'date-time' })),
    status_changed_by: Nullable(Type.String()),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
  },
  { title: 'IntakeRequest' },
);

export const IntakeEvent = Type.Object(
  {
    from_status: Nullable(IntakeStatusSchema),
    to_status: IntakeStatusSchema,
    actor_type: Type.String(),
    actor_account_id: Nullable(Type.String()),
    note: Nullable(Type.String()),
    occurred_at: Type.String({ format: 'date-time' }),
  },
  { title: 'IntakeEvent' },
);

// ------------------------------------------------------------------ outreach

const SkipReasonSchema = Type.Union(
  ['customer_deleted', 'customer_suppressed', 'no_contact', 'opted_out', 'no_consent'].map((s) => Type.Literal(s)),
  { description: 'Why a customer will not / did not get the message.' },
);

const templateHelp =
  'Plain text. Placeholders: {{customer_name}}, {{business_name}}, {{service_type}}, {{response_link}}. ' +
  'If {{response_link}} is missing, a reply link is added at the end. A footer with your business name, ' +
  'mailing address and an unsubscribe link is always added.';

export const Campaign = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    name: Type.String(),
    channel: ChannelSchema,
    purpose: PurposeSchema,
    service_type: Nullable(Type.String()),
    status: Type.Union([Type.Literal('draft'), Type.Literal('sending'), Type.Literal('sent'), Type.Literal('cancelled')]),
    subject: Nullable(Type.String()),
    body: Type.String(),
    template_version: Type.Integer({ description: 'Goes up each time subject or body changes.' }),
    customer_ids: Type.Array(Type.String({ format: 'uuid' })),
    audience_size: Type.Integer(),
    created_by: Nullable(Type.String()),
    approved_by: Nullable(Type.String({ description: 'Who pressed Send.' })),
    sent_at: Nullable(Type.String({ format: 'date-time' })),
    created_at: Type.String({ format: 'date-time' }),
    updated_at: Type.String({ format: 'date-time' }),
    results: Nullable(
      Type.Object({
        sent: Type.Integer(),
        failed: Type.Integer(),
        suppressed: Type.Integer({ description: 'Skipped at send time (opted out, no email, suppressed...).' }),
        queued: Type.Integer(),
      }),
    ),
  },
  { title: 'Campaign' },
);

export const CampaignCreate = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    channel: Type.Optional(ChannelSchema),
    purpose: Type.Optional(PurposeSchema),
    service_type: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    subject: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 5000, description: templateHelp }),
    customer_ids: Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 200 }),
  },
  { title: 'CampaignCreate', additionalProperties: false },
);

export const CampaignUpdate = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    purpose: Type.Optional(PurposeSchema),
    service_type: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    subject: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    body: Type.Optional(Type.String({ minLength: 1, maxLength: 5000, description: templateHelp })),
    customer_ids: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { minItems: 1, maxItems: 200 })),
  },
  { title: 'CampaignUpdate', additionalProperties: false, minProperties: 1 },
);

export const CampaignPreview = Type.Object(
  {
    recipients: Type.Array(
      Type.Object({
        customer_id: Type.String({ format: 'uuid' }),
        customer_name: Nullable(Type.String()),
        email: Nullable(Type.String()),
        will_send: Type.Boolean(),
        reason: Nullable(SkipReasonSchema),
      }),
    ),
    summary: Type.Object({ total: Type.Integer(), will_send: Type.Integer(), skipped: Type.Integer() }),
    sample: Nullable(
      Type.Object(
        { to: Type.String(), subject: Type.String(), text: Type.String(), html: Type.String() },
        { description: 'The email as the first eligible customer would get it, with example links.' },
      ),
    ),
    sender: Type.Object({
      from_name: Type.String(),
      from_email: Nullable(Type.String()),
      reply_to: Nullable(Type.String()),
      mailing_address: Nullable(Type.String()),
      ready: Type.Boolean({ description: 'False means Send will be refused; see problems.' }),
      problems: Type.Array(
        Type.Union([Type.Literal('email_not_configured'), Type.Literal('mailing_address_missing')]),
      ),
    }),
  },
  { title: 'CampaignPreview' },
);

export const OutreachMessage = Type.Object(
  {
    id: Type.String({ format: 'uuid' }),
    customer_id: Type.String({ format: 'uuid' }),
    customer_name: Type.String(),
    recipient: Type.String(),
    status: Type.Union(['queued', 'sent', 'delivered', 'failed', 'suppressed'].map((s) => Type.Literal(s))),
    suppression_reason: Nullable(SkipReasonSchema),
    failure_code: Nullable(Type.String()),
    template_version: Type.Integer(),
    consent_record_id: Nullable(Type.String({ format: 'uuid' })),
    intake_request_id: Nullable(Type.String({ format: 'uuid' })),
    sent_at: Nullable(Type.String({ format: 'date-time' })),
    created_at: Type.String({ format: 'date-time' }),
  },
  { title: 'OutreachMessage' },
);
