-- Let the tenant role use tables in the public schema. Row-level security
-- policies still decide which rows it can see or change.
GRANT USAGE ON SCHEMA public TO app_tenant;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_tenant;--> statement-breakpoint
-- Tables created by later migrations get the same grants automatically.
-- Every new table must enable row-level security; a test enforces this.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_tenant;
