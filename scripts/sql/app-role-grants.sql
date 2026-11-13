-- Least-privilege database login for the running API.
--
-- Two logins:
--   neondb_owner  owns the schema; used ONLY by the deploy workflow to run migrations
--                 (Key Vault secret database-url-unpooled).
--   ldhp_app      used by the API at runtime (Key Vault secret database-url). It can read
--                 and write rows but cannot create, alter or drop tables, and cannot
--                 update or delete audit events.
--
-- Steps (per Neon branch, e.g. dev, later production):
--   1. The role already exists: migration 0007_app_role.sql creates ldhp_app without login
--      and applies these same grants on every deploy. Turn login on in the Neon SQL editor
--      (as neondb_owner) with a password from your password manager:
--        ALTER ROLE ldhp_app WITH LOGIN PASSWORD '<32+ random letters and digits>';
--      (Don't create it again under Console > Roles; that fails because it exists.)
--   2. Optional: run this file too. It re-applies the grants, adds CONNECT, and hides
--      Drizzle's migration table from the app. Safe to run again.
--   3. Build the POOLED connection string for ldhp_app (Connect > role ldhp_app > pooled)
--      and save it as a new version of Key Vault secret database-url. Keep
--      database-url-unpooled on neondb_owner.
--   4. Re-run deploy-dev. Check /v1/health/db, then sign in to the app.
-- Rollback: put the previous neondb_owner value back in database-url and re-run deploy-dev.
-- Safe to run again.

GRANT CONNECT ON DATABASE neondb TO ldhp_app;
GRANT USAGE ON SCHEMA public TO ldhp_app;
REVOKE CREATE ON SCHEMA public FROM ldhp_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ldhp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ldhp_app;

-- Audit log is append-only (a trigger also blocks this, belt and braces).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM ldhp_app;

-- Tables added by future migrations (run as neondb_owner) get the same row access.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ldhp_app;
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ldhp_app;

-- Drizzle's migration bookkeeping is the migrator's business only.
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM ldhp_app;
