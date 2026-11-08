/**
 * R0 MCP spike (PRD v0.2 §5, §9, §11).
 *
 * Three READ-ONLY tools over synthetic test data. Each call:
 *   1. re-verifies the agent's account still has an active membership in its
 *      organization (revocation takes effect on the next call),
 *   2. runs the same org-scoped service functions the REST API uses,
 *   3. writes an audit event attributed to an agent identity, including denials.
 *
 * A "home" in R1 terms is a pro's customer record + service address, so
 * `home_id` is a customer id. Contact details (email/phone) are deliberately
 * not returned to the model (PRD §10: minimize personal data in prompts).
 *
 * Not production: no OAuth client onboarding, no write tools, stdio transport only.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { resolveOrgAccess } from '../services/access.js';
import { recordAudit } from '../services/audit.js';
import type { Actor, ScopedContext } from '../services/context.js';
import { getCustomer } from '../services/customers.js';
import { listDue, listServiceHistory, toServiceRecordDto } from '../services/service-records.js';
import { isUuid } from '../lib/ids.js';
import { randomUUID } from 'node:crypto';

export interface AgentPrincipal {
  /** Platform account the agent acts on behalf of. */
  accountId: string;
  /** Organization the agent session is bound to. */
  organizationId: string;
  /** Attributable agent identity, e.g. "claude-desktop-spike". */
  agentLabel: string;
}

export const MCP_TOOL_NAMES = ['get_home_profile', 'list_due_tasks', 'get_service_history'] as const;

const DENIED_TEXT = 'Not found or not authorized for this home.';

export function createMcpServer(db: Db, principal: AgentPrincipal): McpServer {
  const server = new McpServer({ name: 'living-data-platform-spike', version: '0.1.0' });
  const actor: Actor = { type: 'agent', accountId: principal.accountId, label: principal.agentLabel };

  /** Shared wrapper: authorize, run, audit. */
  async function run(
    tool: (typeof MCP_TOOL_NAMES)[number],
    homeId: string,
    body: (ctx: ScopedContext) => Promise<unknown | null>,
  ): Promise<CallToolResult> {
    const requestId = randomUUID();
    const audit = (outcome: 'success' | 'denied' | 'error', reason?: string) =>
      recordAudit(db, {
        actor,
        organizationId: principal.organizationId,
        action: `mcp.${tool}`,
        outcome,
        recordType: 'customer',
        recordId: homeId,
        requestId,
        metadata: { tool, read_only: true, ...(reason ? { reason } : {}) },
      });
    const denied = async (reason: string): Promise<CallToolResult> => {
      await audit('denied', reason);
      return { isError: true, content: [{ type: 'text', text: DENIED_TEXT }] };
    };

    const access = await resolveOrgAccess(db, principal.accountId, principal.organizationId);
    if (!access) return denied('no_active_membership');
    if (!isUuid(homeId)) return denied('invalid_home_id');

    const ctx: ScopedContext = { db, actor, requestId, ...access };
    try {
      const result = await body(ctx);
      // null => the record is not in the agent's organization (or doesn't exist).
      if (result === null) return denied('home_not_in_scope');
      await audit('success');
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (err) {
      await audit('error', (err as Error).name);
      return { isError: true, content: [{ type: 'text', text: 'Internal error.' }] };
    }
  }

  const homeId = z.string().describe('The home (customer) id.');
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    'get_home_profile',
    {
      title: 'Get home profile',
      description: 'Service address and service summary for a home in your organization.',
      inputSchema: { home_id: homeId },
      annotations: readOnly,
    },
    async ({ home_id }) =>
      run('get_home_profile', home_id, async (ctx) => {
        const c = await getCustomer(ctx, home_id);
        if (!c) return null;
        const h = await listServiceHistory(ctx, home_id, 500);
        const services = new Map<string, { last_completed_on: string; next_due_on: string | null }>();
        for (const r of h?.records ?? []) {
          if (!services.has(r.serviceType))
            services.set(r.serviceType, { last_completed_on: r.completedOn, next_due_on: r.nextDueOn });
        }
        return {
          home_id: c.id,
          name: c.displayName,
          address: {
            line1: c.addressLine1,
            line2: c.addressLine2,
            city: c.city,
            region: c.region,
            postal_code: c.postalCode,
          },
          has_email: !!c.email,
          has_phone: !!c.phone,
          suppressed: c.suppressed,
          service_count: h?.records.length ?? 0,
          services: [...services].map(([service_type, v]) => ({ service_type, ...v })),
        };
      }),
  );

  server.registerTool(
    'list_due_tasks',
    {
      title: 'List due tasks',
      description: 'Services due or overdue for a home, within the given window (days).',
      inputSchema: {
        home_id: homeId,
        within_days: z.number().int().min(0).max(365).default(30).describe('Look-ahead window in days.'),
      },
      annotations: readOnly,
    },
    async ({ home_id, within_days }) =>
      run('list_due_tasks', home_id, async (ctx) => {
        if (!(await getCustomer(ctx, home_id))) return null;
        const items = await listDue(ctx, { withinDays: within_days, customerId: home_id });
        return {
          home_id,
          within_days,
          tasks: items.map(({ customer_name: _omit, ...rest }) => rest),
        };
      }),
  );

  server.registerTool(
    'get_service_history',
    {
      title: 'Get service history',
      description: 'Completed services for a home, newest first.',
      inputSchema: {
        home_id: homeId,
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: readOnly,
    },
    async ({ home_id, limit }) =>
      run('get_service_history', home_id, async (ctx) => {
        const h = await listServiceHistory(ctx, home_id, limit);
        if (!h) return null;
        return { home_id, records: h.records.map(toServiceRecordDto) };
      }),
  );

  return server;
}
