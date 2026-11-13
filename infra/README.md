# Dev hosting on Azure Container Apps

`main.bicep` creates everything in one resource group (`rg-ldhp-dev`). The deploy
workflow `.github/workflows/deploy-dev.yml` runs it from GitHub with federated sign-in
(no stored Azure password), only from `main`, and only after the owner approves the run
in the GitHub `dev` environment.

| Resource | Name | Why |
|---|---|---|
| Container Apps environment + app | `cae-ldhp-dev`, `ca-ldhp-dev` | Runs the API. Consumption plan, 0.25 vCPU / 0.5 GiB, 0-2 replicas |
| Container registry (Basic) | `crldhpdev…` | Holds the API image, private |
| Key Vault | `kv-ldhp-dev-…` | Holds the API's secrets; the app reads them with its own identity |
| Managed identity | `id-ldhp-dev` | The app's identity for Key Vault |
| Log Analytics | `log-ldhp-dev` | App logs, 30-day retention, 0.15 GB/day cap |

## Expected cost (list prices, verify in the Azure pricing calculator)

- Container Apps, scale to zero: the monthly free grant (180,000 vCPU-seconds, 360,000 GiB-seconds,
  2M requests) covers dev and light pilot traffic: about **$0**.
- Container Registry Basic: about **$5/month**.
- Key Vault, Log Analytics (under the 5 GB/month free tier): about **$0**.
- Total: **about $5-10/month**. Always on (`LDHP_MIN_REPLICAS=1`) adds roughly $5-15/month.

A $10 monthly budget alert on the subscription is the backstop.

## First-time setup (owner)

1. Done already: resource group, `ldhp-github-deploy` app with Contributor on the group,
   federated credential for environment `dev`, GitHub `dev` environment, the three `AZURE_*` variables.
2. Add GitHub variable `AZURE_ADMIN_OBJECT_ID`: Entra ID > Users > you > **Object ID**.
3. Run **Actions > deploy-dev > Run workflow** and approve it. This creates the resources with a
   placeholder app (no secrets yet). The run summary names the Key Vault.
4. In that Key Vault > **Secrets** > **Generate/Import**, add:
   - `database-url`: Neon **pooled** connection string for the `dev` branch
   - `database-url-unpooled`: Neon **direct** connection string (used only for migrations)
   - `clerk-secret-key`: Clerk **development** instance secret key
5. Set GitHub variable `LDHP_SECRETS_READY` = `true` and run the workflow again. It builds the image,
   applies migrations, rolls out, and checks `/v1/health/db`. The URL is in the run summary.

## Switching cost modes

- Always on (no cold start): set `LDHP_MIN_REPLICAS` = `1`, rerun the workflow.
- Back to scale to zero: set it to `0`.

## Letting a front end call the API

Set GitHub variable `CLERK_AUTHORIZED_PARTIES` to the front end's exact origin(s), comma-separated
(e.g. `https://pro-app.replit.app,https://pro-app-dev.replit.dev`), and re-run the workflow. The API
then accepts browser calls (CORS) and Clerk tokens only from those origins.

## Turning on outreach email (SendGrid)

Until these are set, staff can draft and preview campaigns, but Send returns `503 email_not_configured`.

1. In SendGrid, authenticate a sending domain (e.g. `mail.living-data.com`) with the DNS records it gives you, and
   create an API key with **Mail Send** permission only.
2. Add the key to the dev vault as secret `sendgrid-api-key`.
3. GitHub variables in the `dev` environment:
   - `EMAIL_FROM_ADDRESS`: an address on that domain, e.g. `reminders@mail.living-data.com`. The business name is
     shown as the sender name, and customer replies go to the workspace's `reply_to_email`.
   - `PUBLIC_APP_URL`: the front-end origin that serves `/r` (customer response) and `/unsubscribe`.
   - `LDHP_SENDGRID_READY`: `true`.
4. Re-run deploy-dev.

Each workspace must also save a `mailing_address` in Settings before it can send (it's printed in every email
footer). Click and open tracking are turned off so link tokens never pass through SendGrid's redirector.

## Running the API as the least-privilege database role

Migration `0007_app_role.sql` creates `ldhp_app` (no login yet). It can read and write rows, can only append to
`audit_events`, and cannot change the schema, truncate tables or manage roles. Deploys keep running migrations as
the owner through `database-url-unpooled`; only the running API switches.

Do this per environment, testing on a throwaway Neon branch first:

1. In the Neon Console, create a branch from `dev` (e.g. `role-test`) and open its **SQL Editor**.
2. Turn on login with a strong password (generate 32+ random letters and digits in your password manager):
   `ALTER ROLE ldhp_app WITH LOGIN PASSWORD '<generated>';`
3. Build the pooled URL: take the branch's pooled connection string and replace the user and password with
   `ldhp_app` and the new password. Check it locally with `DATABASE_URL=<url> npm run db:smoke`.
4. If that works, repeat steps 2-3 on `dev`, then set the vault secret `database-url` to the new URL (leave
   `database-url-unpooled` as the owner) and re-run deploy-dev. `/v1/health/db` should say ok.
5. Rollback: put the previous `database-url` value back and re-run deploy-dev.

Delete the test branch afterwards. Never paste the password in chat or commit it.

`scripts/sql/app-role-grants.sql` re-applies the same grants (plus `CONNECT` and hiding Drizzle's migration
table) if you ever need to repair them; running it is optional and safe to repeat. Don't create `ldhp_app` under
Console > Roles: the migration already created it.
