-- Role that every tenant-scoped query runs as (via SET LOCAL ROLE).
-- Row-level security policies are attached to it. It cannot log in.
-- Roles are shared by all databases on a server, so it may already exist,
-- possibly created a moment ago by a migration running in parallel.
DO $$
BEGIN
  CREATE ROLE app_tenant NOLOGIN;
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN
    NULL;
END
$$;
