import type { Db } from '../db/client.js';
import { auditEvents } from '../db/schema.js';
import type { Actor } from './context.js';

export interface AuditInput {
  actor: Actor;
  organizationId: string | null;
  action: string;
  outcome?: 'success' | 'denied' | 'error';
  recordType?: string;
  recordId?: string;
  requestId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** Append an audit event. Pass a transaction handle to make it atomic with the write. */
export async function recordAudit(db: Db, e: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    actorType: e.actor.type,
    actorAccountId: e.actor.accountId,
    actorLabel: e.actor.label ?? null,
    organizationId: e.organizationId,
    action: e.action,
    outcome: e.outcome ?? 'success',
    recordType: e.recordType ?? null,
    recordId: e.recordId ?? null,
    requestId: e.requestId ?? null,
    before: e.before ?? null,
    after: e.after ?? null,
    metadata: e.metadata ?? {},
  });
}
