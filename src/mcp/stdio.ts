/**
 * Run the MCP spike over stdio against a dev database with synthetic data:
 *   DATABASE_URL=... MCP_ACTOR_CLERK_USER_ID=user_test_staff_a \
 *   MCP_ORGANIZATION_ID=0a000000-0000-4000-8000-00000000000a npm run mcp:spike
 * Logs go to stderr; stdout is reserved for the MCP protocol.
 */
import { eq } from 'drizzle-orm';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPgDb } from '../db/client.js';
import { accounts } from '../db/schema.js';
import { createMcpServer } from './server.js';

if (process.env.NODE_ENV === 'production') {
  console.error('The MCP spike is not enabled in production (PRD §9).');
  process.exit(1);
}
const { DATABASE_URL, MCP_ACTOR_CLERK_USER_ID, MCP_ORGANIZATION_ID } = process.env;
if (!DATABASE_URL || !MCP_ACTOR_CLERK_USER_ID || !MCP_ORGANIZATION_ID) {
  console.error('DATABASE_URL, MCP_ACTOR_CLERK_USER_ID and MCP_ORGANIZATION_ID are required');
  process.exit(1);
}
const { db } = createPgDb(DATABASE_URL);
const [account] = await db
  .select({ id: accounts.id })
  .from(accounts)
  .where(eq(accounts.clerkUserId, MCP_ACTOR_CLERK_USER_ID))
  .limit(1);
if (!account) {
  console.error('No platform account for MCP_ACTOR_CLERK_USER_ID');
  process.exit(1);
}
const server = createMcpServer(db, {
  accountId: account.id,
  organizationId: MCP_ORGANIZATION_ID,
  agentLabel: process.env.MCP_AGENT_LABEL ?? 'mcp-spike-stdio',
});
await server.connect(new StdioServerTransport());
console.error('Living Data MCP spike running on stdio');
