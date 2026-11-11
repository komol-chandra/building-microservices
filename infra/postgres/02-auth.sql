-- Phase 9: database for auth-service. Same rules as init.sql (own DB + own user).
-- Idempotent, so it can also be run by hand on an EXISTING volume
-- (docker-entrypoint-initdb.d only runs on an empty one):
--   docker compose exec -T postgres psql -U postgres < infra/postgres/02-auth.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_svc') THEN
    CREATE USER auth_svc WITH PASSWORD 'auth_pw' CREATEDB;
  END IF;
END $$;

-- CREATE DATABASE can't run inside DO/IF, so \gexec runs it only when the SELECT returns a row.
SELECT 'CREATE DATABASE auth_db OWNER auth_svc'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'auth_db')\gexec

REVOKE CONNECT ON DATABASE auth_db FROM PUBLIC;
GRANT  CONNECT ON DATABASE auth_db TO auth_svc;
