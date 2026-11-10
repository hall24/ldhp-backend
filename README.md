# Living Data Platform: backend (R0)

Shared API for Living Data apps, per **PRD v0.2**. This is the R0 scaffold and
platform spike: data model, org-scoped auth, OpenAPI contract, and a read-only
MCP spike. R1 workflows (outreach sending, intake links, billing) are not built yet.

**Stack:** TypeScript, Node 22, Fastify 5, Drizzle ORM, Neon Postgres, Clerk.
Tests run against an in-process Postgres (PGlite), so no database is needed to run them.

## Quick start

```bash
npm install
npm test                 # 74 tests, no external services
cp .env.example .env     # fill in dev values from the dev Key Vault
npm run db:migrate       # apply drizzle/ migrations (uses DATABASE_MIGRATION_URL)
npm run db:seed          # synthetic test data (refuses NODE_ENV=production)
npm run dev              # http://localhost:3000, Swagger UI at /docs
```

## Neon branches

- `dev`: long-lived shared development database (migrated + synthetic seed). The hosted dev API and Replit front ends use it. Get its env with `neon checkout dev` (writes `.env.local`).
- `production`: untouched until launch.
- Other branches created with `neon checkout <name> --create` auto-expire after 7 days (see `neon.ts`).

## How authorization works

1. Every request carries a Clerk session token (`Authorization: Bearer ...`). The API verifies it and maps the Clerk user to a platform `account`.
2. Tenant routes require `X-Organization-Id`. The server accepts it **only** if that account has an active `membership` in that org. The client's org id is never trusted on its own, and Clerk's org claim is not used for authorization.
3. Every query filters by the verified `organization_id`. Another org's record returns **404**, not 403, so existence isn't leaked.
4. Roles: `owner`, `staff` (PRD §8). Denials (wrong org, wrong role) are written to the audit log.
5. Revoking a membership takes effect on the next request (no cached grants).

## Data model (draft, `src/db/schema.ts`)

`accounts`, `organizations`, `memberships`, `customers`, `service_records`, `consent_records`,
`outreach_campaigns`, `outreach_messages`, `intake_requests`, `files`, `idempotency_keys`, `audit_events`.

- Tenant-owned tables carry `organization_id`. Child tables use **composite foreign keys** `(organization_id, parent_id)` so a row can't point at a parent in another org.
- `audit_events` is **append-only**: a trigger blocks UPDATE, DELETE and TRUNCATE.
- Intake links store only a **hash** of the token. Consent withdrawal is kept as a suppression state, never deleted.
- Write endpoints accept an `Idempotency-Key` header; retries replay the original response.

## API

Contract: [`openapi/openapi.json`](openapi/openapi.json), regenerated with `npm run openapi:export`
(CI fails if it is stale). Implemented in R0:

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/health` | public |
| GET | `/v1/me` | account + memberships |
| GET/POST | `/v1/customers` | cursor pagination, idempotent create |
| GET | `/v1/customers/{id}` | |
| GET/POST | `/v1/customers/{id}/service-records` | `next_due_on = completed_on + interval_days` |
| GET | `/v1/due-queue?within_days=30` | org time zone, excludes suppressed |
| GET | `/v1/audit-events` | owners only |
| POST | `/v1/organizations` | self-serve workspace setup; caller becomes owner; idempotent |
| GET / PATCH | `/v1/organization` | workspace settings (time zone, sender name, service types, area); PATCH owners only |
| PATCH | `/v1/customers/{id}` | partial edit, incl. `suppressed` |
| DELETE | `/v1/customers/{id}` | owners only; soft delete |
| PATCH / DELETE | `/v1/customers/{id}/service-records/{recordId}` | correct dates (due date recomputed or set directly); soft delete |
| POST / GET | `/v1/invitations` | owners: create a 7-day single-use invite link (token shown once, only its hash stored), list pending |
| DELETE | `/v1/invitations/{id}` | owners: revoke a pending invite |
| POST | `/v1/invitations/accept` | signed-in user joins with a token; unknown/expired/revoked/used all return the same 404 |
| GET | `/v1/members` | active members |
| PATCH / DELETE | `/v1/members/{id}` | owners: change role, revoke access; the last owner is protected |
| GET / POST | `/v1/customers/{id}/consents` | contact permissions (channel, contact, purpose, source, time) |
| POST | `/v1/customers/{id}/consents/{consentId}/withdraw` | opt-out, kept as suppression |
| POST | `/v1/customers/{id}/intake-requests` | create a 14-day customer response link (token shown once, hash stored) |
| GET | `/v1/intake-requests?status=open` | intake queue, cursor pagination |
| GET / PATCH | `/v1/intake-requests/{id}` | detail with status history; staff move it to contacted / scheduled_externally / not_proceeding / unable_to_reach |
| POST | `/v1/intake-requests/{id}/revoke-link` | kill the customer link |
| POST | `/v1/public/intake/view`, `/v1/public/intake/respond` | **no auth**: customer opens their link and answers; token in body, never URL; optional unsubscribe |

Errors always look like `{ "error": { "code", "message", "request_id" } }`.

## MCP spike (R0 gate)

`src/mcp/server.ts` exposes three **read-only** tools over synthetic data:
`get_home_profile`, `list_due_tasks`, `get_service_history`. A "home" is a customer record.

- Each call re-checks the agent account's membership, uses the same scoped service code as the REST API, and writes an audit event with `actor_type = agent`.
- Asking for a home in another org returns "Not found or not authorized" and records a `denied` audit event.
- Contact details are not returned to the model.

Proof: `test/mcp.test.ts`. To try it in an MCP client (dev DB with seed data):

```json
{
  "mcpServers": {
    "living-data-spike": {
      "command": "npx",
      "args": ["tsx", "src/mcp/stdio.ts"],
      "cwd": "/path/to/ldhp-backend",
      "env": {
        "DATABASE_URL": "postgres://...",
        "MCP_ACTOR_CLERK_USER_ID": "user_test_staff_a",
        "MCP_ORGANIZATION_ID": "0a000000-0000-4000-8000-00000000000a"
      }
    }
  }
}
```

Then ask for home `a1000000-0000-4000-8000-000000000001` (allowed) and
`b1000000-0000-4000-8000-000000000001` (other org, denied). Not for production (PRD §9).

## Secrets

Read from environment variables only. Real values live in Azure Key Vault (separate dev vault);
`.env` is git-ignored and only `.env.example` is committed. Logs redact `Authorization` and cookies.

## Not yet built (R1)

Outreach sending (consent check is ready in `checkEligibility`), CSV import/export, Stripe Billing, SendGrid, scheduler, file storage, support access, retention jobs.
