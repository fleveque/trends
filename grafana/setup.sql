-- One-time Postgres setup for the Grafana datasource.
--
-- Creates a least-privilege `grafana_reader` role with SELECT-only access on
-- the events table. Run ONCE after the first Trends deploy (when Postgres and
-- the `events` table exist).
--
-- Usage (from your workstation):
--
--   kamal accessory exec postgres --reuse \
--     'psql -U trends -d trends -v password=<choose-a-password>' < grafana/setup.sql
--
-- Or interactively:
--
--   kamal accessory exec postgres --interactive --reuse \
--     'psql -U trends -d trends'
--
--   then paste the SQL below, replacing <PASSWORD> with the value of
--   TRENDS_GRAFANA_READER_PASSWORD from the Bitwarden quantic-prod note.
--
-- Idempotent: safe to re-run. CREATE ROLE is guarded; the ALTER ROLE
-- updates the password if it changes.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_reader') THEN
    EXECUTE format('CREATE ROLE grafana_reader WITH LOGIN PASSWORD %L', :'password');
  ELSE
    EXECUTE format('ALTER ROLE grafana_reader WITH LOGIN PASSWORD %L', :'password');
  END IF;
END
$$;

GRANT CONNECT ON DATABASE trends TO grafana_reader;
GRANT USAGE ON SCHEMA public TO grafana_reader;
GRANT SELECT ON events TO grafana_reader;

-- Future tables in `public` will automatically be readable by grafana_reader.
-- The trade-off: if we add a new table with PII, we'd need to REVOKE it.
-- For Trends today there's only `events` and the `_prisma_migrations`
-- bookkeeping table, neither of which carries cross-user identifiers
-- beyond the slug — which the operator can already see.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grafana_reader;
