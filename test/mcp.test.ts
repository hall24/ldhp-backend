import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { and, desc, eq, like } from 'drizzle-orm';
import { createTestDb } from './helpers/db.js';
import { seedSynthetic, SEED } from '../src/db/seed.js';
import { createMcpServer, type AgentPrincipal } from '../src/mcp/server.js';
import { auditEvents, memberships } from '../src/db/schema.js';
import type { Db } from '../src/db/client.js';

let db: Db;
let close: () => Promise<void>;

async function connect(principal: AgentPrincipal) {
  const server = createMcpServer(db, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'spike-test', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

const agentA: AgentPrincipal = { accountId: SEED.staffA.id, organizationId: SEED.orgA, agentLabel: 'test-agent' };

async function lastMcpAudit() {
  const [row] = await db
    .select()
    .from(auditEvents)
    .where(like(auditEvents.action, 'mcp.%'))
    .orderBy(desc(auditEvents.id))
    .limit(1);
  return row!;
}

const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
  (r.content as Array<{ type: string; text: string }>)[0]!.text;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  await seedSynthetic(db);
});
afterAll(async () => close());

describe('MCP spike', () => {
  it('exposes exactly three read-only tools', async () => {
    const client = await connect(agentA);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_home_profile', 'get_service_history', 'list_due_tasks']);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it('get_home_profile returns the test home without contact details, and audits as an agent', async () => {
    const client = await connect(agentA);
    const res = await client.callTool({ name: 'get_home_profile', arguments: { home_id: SEED.homeA1 } });
    expect(res.isError).toBeFalsy();
    const profile = res.structuredContent as Record<string, unknown>;
    expect(profile).toMatchObject({ home_id: SEED.homeA1, has_email: true, has_phone: true, service_count: 4 });
    expect(text(res)).not.toContain('home1@example.test');
    expect(text(res)).not.toContain('+15555550101');

    const ev = await lastMcpAudit();
    expect(ev).toMatchObject({
      action: 'mcp.get_home_profile',
      outcome: 'success',
      actorType: 'agent',
      actorLabel: 'test-agent',
      actorAccountId: SEED.staffA.id,
      organizationId: SEED.orgA,
      recordId: SEED.homeA1,
    });
  });

  it('list_due_tasks returns overdue and due-soon tasks for the home', async () => {
    const client = await connect(agentA);
    const res = await client.callTool({ name: 'list_due_tasks', arguments: { home_id: SEED.homeA1, within_days: 30 } });
    const tasks = (res.structuredContent as { tasks: Array<{ service_type: string; status: string }> }).tasks;
    expect(tasks.map((t) => [t.service_type, t.status])).toEqual([
      ['gutter_cleaning', 'overdue'],
      ['window_washing', 'due_soon'],
    ]);
  });

  it('get_service_history returns records newest first', async () => {
    const client = await connect(agentA);
    const res = await client.callTool({ name: 'get_service_history', arguments: { home_id: SEED.homeA1, limit: 10 } });
    const records = (res.structuredContent as { records: Array<{ completed_on: string }> }).records;
    expect(records).toHaveLength(4);
    const dates = records.map((r) => r.completed_on);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("denies another organization's home and records a denied audit event", async () => {
    const client = await connect(agentA);
    for (const name of ['get_home_profile', 'list_due_tasks', 'get_service_history']) {
      const res = await client.callTool({ name, arguments: { home_id: SEED.homeB1 } });
      expect(res.isError).toBe(true);
      expect(text(res)).toBe('Not found or not authorized for this home.');
      expect(text(res)).not.toContain('Other Org Home');
      const ev = await lastMcpAudit();
      expect(ev).toMatchObject({
        action: `mcp.${name}`,
        outcome: 'denied',
        actorType: 'agent',
        recordId: SEED.homeB1,
        organizationId: SEED.orgA,
      });
      expect(ev.metadata).toMatchObject({ reason: 'home_not_in_scope' });
    }
  });

  it('denies an agent bound to an org its account is not a member of', async () => {
    const client = await connect({ ...agentA, organizationId: SEED.orgB });
    const res = await client.callTool({ name: 'get_home_profile', arguments: { home_id: SEED.homeB1 } });
    expect(res.isError).toBe(true);
    expect((await lastMcpAudit()).metadata).toMatchObject({ reason: 'no_active_membership' });
  });

  it('stops working on the next call after the membership is revoked', async () => {
    const client = await connect(agentA);
    const ok = await client.callTool({ name: 'get_home_profile', arguments: { home_id: SEED.homeA1 } });
    expect(ok.isError).toBeFalsy();
    await db
      .update(memberships)
      .set({ status: 'revoked' })
      .where(and(eq(memberships.accountId, SEED.staffA.id), eq(memberships.organizationId, SEED.orgA)));
    const denied = await client.callTool({ name: 'get_home_profile', arguments: { home_id: SEED.homeA1 } });
    expect(denied.isError).toBe(true);
    expect((await lastMcpAudit()).metadata).toMatchObject({ reason: 'no_active_membership' });
    await db.update(memberships).set({ status: 'active' }).where(eq(memberships.accountId, SEED.staffA.id));
  });
});
