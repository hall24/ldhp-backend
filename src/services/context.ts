import type { Db } from '../db/client.js';

export type ActorType = 'user' | 'agent' | 'system' | 'customer_link';

export interface Actor {
  type: ActorType;
  /** The platform account the action is attributed to (agents act on behalf of an account). */
  accountId: string | null;
  /** e.g. agent/client name; never a secret. */
  label?: string;
}

export type Role = 'owner' | 'staff';

/** Everything a tenant-scoped service call needs. `organizationId` is server-verified. */
export interface ScopedContext {
  db: Db;
  actor: Actor;
  organizationId: string;
  role: Role;
  timeZone: string;
  requestId: string;
}
