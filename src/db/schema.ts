/**
 * R1 data model draft (PRD v0.2 §7).
 *
 * Ownership rule: every tenant-owned record carries `organization_id` (the owning
 * workspace). Child records (e.g. outreach messages) also carry it so that every
 * query can be scoped with a single predicate, and composite foreign keys make it
 * impossible for a child to point at a parent owned by a different organization.
 *
 * The API layer (not the database) is the authorization boundary; these
 * constraints are defence in depth.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const membershipRole = pgEnum('membership_role', ['owner', 'staff']);
export const membershipStatus = pgEnum('membership_status', ['active', 'revoked']);
export const channel = pgEnum('channel', ['email', 'sms']);
export const campaignStatus = pgEnum('campaign_status', ['draft', 'sending', 'sent', 'cancelled']);
export const messageStatus = pgEnum('message_status', [
  'queued',
  'sent',
  'delivered',
  'failed',
  'suppressed',
]);
export const intakeResponse = pgEnum('intake_response', [
  'request_service',
  'decline',
  'contact_me',
]);
export const intakeStatus = pgEnum('intake_status', [
  'awaiting_response',
  'received',
  'contacted',
  'scheduled_externally',
  'not_proceeding',
  'unable_to_reach',
]);
export const consentPurpose = pgEnum('consent_purpose', ['service_reminders', 'marketing']);
export const actorType = pgEnum('actor_type', ['user', 'agent', 'system', 'support', 'customer_link']);
export const auditOutcome = pgEnum('audit_outcome', ['success', 'denied', 'error']);

// ---------------------------------------------------------------------------
// Identity and tenancy
// ---------------------------------------------------------------------------

/** A person, linked 1:1 to a Clerk user. Workspace access comes only from membership. */
export const accounts = pgTable('accounts', {
  id: id(),
  clerkUserId: text('clerk_user_id').notNull().unique(),
  email: text('email'),
  displayName: text('display_name'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/** A pro business workspace: the tenant boundary. */
export const organizations = pgTable(
  'organizations',
  {
  id: id(),
  /** Optional link to a Clerk Organization; authorization still uses `memberships`. */
  clerkOrgId: text('clerk_org_id').unique(),
  name: text('name').notNull(),
  timeZone: text('time_zone').notNull().default('America/New_York'),
  /** Sender identity shown on outreach (PRD §4 step 1). */
  messageFromName: text('message_from_name'),
  /** Service types the business offers, e.g. "gutter_cleaning" (PRD §4 step 1). */
  serviceTypes: text('service_types')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  /** Free-text service area, e.g. "Bergen County, NJ". */
  serviceArea: text('service_area'),
  createdBy: uuid('created_by').references(() => accounts.id),
  /** Idempotency-Key of the create request, so a retried signup can't make two workspaces. */
  creationKey: text('creation_key'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
},
(t) => [uniqueIndex('organizations_creation_key_uq').on(t.createdBy, t.creationKey)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    role: membershipRole('role').notNull(),
    status: membershipStatus('status').notNull().default('active'),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [unique('memberships_org_account_uq').on(t.organizationId, t.accountId)],
);

// ---------------------------------------------------------------------------
// Customers and service history
// ---------------------------------------------------------------------------

/** A pro's customer and service address. Owned by exactly one organization. */
export const customers = pgTable(
  'customers',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    displayName: text('display_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: text('postal_code'),
    /** Staff can suppress a customer from the due queue (PRD §4 step 4). */
    suppressed: boolean('suppressed').notNull().default(false),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => accounts.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    unique('customers_org_id_uq').on(t.organizationId, t.id),
    index('customers_org_created_idx').on(t.organizationId, t.createdAt, t.id),
  ],
);

/** Completed work. `next_due_on` drives the due queue. */
export const serviceRecords = pgTable(
  'service_records',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    serviceType: text('service_type').notNull(),
    completedOn: date('completed_on').notNull(),
    notes: text('notes'),
    intervalDays: integer('interval_days'),
    nextDueOn: date('next_due_on'),
    createdBy: uuid('created_by').references(() => accounts.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'service_records_customer_fk',
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
    }),
    index('service_records_org_due_idx').on(t.organizationId, t.nextDueOn),
    index('service_records_customer_idx').on(t.organizationId, t.customerId, t.completedOn),
  ],
);

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Permission to contact. Scoped to contact value + channel + business sender
 * (the owning org) + purpose. Withdrawal is retained as a suppression state and
 * never deleted.
 */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    channel: channel('channel').notNull(),
    contactValue: text('contact_value').notNull(),
    purpose: consentPurpose('purpose').notNull(),
    /** Where the consent came from, e.g. "paper_form", "web_form", "verbal_recorded". */
    source: text('source').notNull(),
    evidence: jsonb('evidence'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull(),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawalSource: text('withdrawal_source'),
    recordedBy: uuid('recorded_by').references(() => accounts.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'consent_records_customer_fk',
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
    }),
    unique('consent_records_org_id_uq').on(t.organizationId, t.id),
    index('consent_records_lookup_idx').on(t.organizationId, t.channel, t.contactValue),
  ],
);

// ---------------------------------------------------------------------------
// Outreach
// ---------------------------------------------------------------------------

export const outreachCampaigns = pgTable(
  'outreach_campaigns',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    channel: channel('channel').notNull(),
    status: campaignStatus('status').notNull().default('draft'),
    templateSubject: text('template_subject'),
    templateBody: text('template_body').notNull(),
    templateVersion: integer('template_version').notNull().default(1),
    createdBy: uuid('created_by').references(() => accounts.id),
    approvedBy: uuid('approved_by').references(() => accounts.id),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('outreach_campaigns_org_id_uq').on(t.organizationId, t.id)],
);

/** One send to one recipient. Stores everything PRD §10 requires per send. */
export const outreachMessages = pgTable(
  'outreach_messages',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    campaignId: uuid('campaign_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    channel: channel('channel').notNull(),
    recipient: text('recipient').notNull(),
    senderIdentity: text('sender_identity').notNull(),
    templateVersion: integer('template_version').notNull(),
    consentRecordId: uuid('consent_record_id'),
    status: messageStatus('status').notNull().default('queued'),
    suppressionReason: text('suppression_reason'),
    providerMessageId: text('provider_message_id'),
    providerResult: jsonb('provider_result'),
    /** Prevents duplicate sends on retry (PRD §9). */
    idempotencyKey: text('idempotency_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'outreach_messages_campaign_fk',
      columns: [t.organizationId, t.campaignId],
      foreignColumns: [outreachCampaigns.organizationId, outreachCampaigns.id],
    }),
    foreignKey({
      name: 'outreach_messages_customer_fk',
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
    }),
    foreignKey({
      name: 'outreach_messages_consent_fk',
      columns: [t.organizationId, t.consentRecordId],
      foreignColumns: [consentRecords.organizationId, consentRecords.id],
    }),
    unique('outreach_messages_org_id_uq').on(t.organizationId, t.id),
    uniqueIndex('outreach_messages_idem_uq').on(t.organizationId, t.idempotencyKey),
  ],
);

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/**
 * Customer response collected through a signed, single-purpose link.
 * Only a hash of the link token is stored; the token itself never touches the DB.
 */
export const intakeRequests = pgTable(
  'intake_requests',
  {
    id: id(),
    organizationId: uuid('organization_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    outreachMessageId: uuid('outreach_message_id'),
    status: intakeStatus('status').notNull().default('awaiting_response'),
    response: intakeResponse('response'),
    customerNote: text('customer_note'),
    linkTokenHash: text('link_token_hash').notNull().unique(),
    linkExpiresAt: timestamp('link_expires_at', { withTimezone: true }).notNull(),
    linkRevokedAt: timestamp('link_revoked_at', { withTimezone: true }),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    statusChangedBy: uuid('status_changed_by').references(() => accounts.id),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'intake_requests_customer_fk',
      columns: [t.organizationId, t.customerId],
      foreignColumns: [customers.organizationId, customers.id],
    }),
    foreignKey({
      name: 'intake_requests_message_fk',
      columns: [t.organizationId, t.outreachMessageId],
      foreignColumns: [outreachMessages.organizationId, outreachMessages.id],
    }),
    index('intake_requests_org_status_idx').on(t.organizationId, t.status, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Metadata only; bytes live in object storage. Access is checked via the linked record. */
export const files = pgTable(
  'files',
  {
    id: id(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    linkedRecordType: text('linked_record_type').notNull(),
    linkedRecordId: uuid('linked_record_id').notNull(),
    storageKey: text('storage_key').notNull().unique(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    scanStatus: text('scan_status').notNull().default('pending'),
    uploadedBy: uuid('uploaded_by').references(() => accounts.id),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [index('files_linked_idx').on(t.organizationId, t.linkedRecordType, t.linkedRecordId)],
);

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/** Stores the first response for an (org, actor, key) so retries replay it. */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idempotency_keys_pk').on(t.organizationId, t.accountId, t.key)],
);

// ---------------------------------------------------------------------------
// Audit (append-only; UPDATE/DELETE blocked by trigger in migration)
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: actorType('actor_type').notNull(),
    actorAccountId: uuid('actor_account_id'),
    /** Human-readable actor, e.g. agent name for MCP calls. No secrets. */
    actorLabel: text('actor_label'),
    organizationId: uuid('organization_id'),
    action: text('action').notNull(),
    outcome: auditOutcome('outcome').notNull().default('success'),
    recordType: text('record_type'),
    recordId: text('record_id'),
    requestId: text('request_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('audit_events_org_time_idx').on(t.organizationId, t.occurredAt),
    index('audit_events_record_idx').on(t.recordType, t.recordId),
  ],
);
