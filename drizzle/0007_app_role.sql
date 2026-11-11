-- Least-privilege application role (PRD §8 defence in depth).
--
-- Two roles use the database:
--   * the migrator (the database owner, e.g. neondb_owner) runs these migrations and
--     owns every table. Only deploys use it (DATABASE_URL_UNPOOLED).
--   * ldhp_app is what the running API connects as (DATABASE_URL). It can read and
--     write rows, and nothing else: no DDL, no TRUNCATE, no role changes, and it can
--     only append to audit_events.
--
-- The role is created without LOGIN. Turning it on, with a password, is a one-time
-- manual step per environment (see infra/README.md), so no credential is ever in git.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ldhp_app') THEN
    CREATE ROLE ldhp_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ldhp_app;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM ldhp_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ldhp_app;
--> statement-breakpoint
-- Audit trail: append and read only. (The append-only trigger also blocks the owner.)
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM ldhp_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ldhp_app;
--> statement-breakpoint
-- Tables and sequences that later migrations create get the same row-level access.
-- (A later table that must be append-only has to revoke UPDATE/DELETE itself.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ldhp_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ldhp_app;
