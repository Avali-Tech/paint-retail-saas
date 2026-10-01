-- Platform console (roadmap P1-M23): what tenants may touch, and what is audited.

-- 1. Platform tables are invisible to tenants.
REVOKE ALL ON platform_admins, platform_sessions FROM app_tenant;--> statement-breakpoint

-- 2. Tenants may rename their business, nothing else: the plan, feature flags
--    and suspension are set by the platform only.
REVOKE UPDATE ON organizations FROM app_tenant;--> statement-breakpoint
GRANT UPDATE (name, updated_at) ON organizations TO app_tenant;--> statement-breakpoint

-- 3. Support grants are created by the platform; tenants only decide or end them.
--    The access log is written by the platform and only read by tenants.
REVOKE INSERT, DELETE, TRUNCATE ON support_grants FROM app_tenant;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON support_access_log FROM app_tenant;--> statement-breakpoint

-- 4. Support sessions belong to their grant.
ALTER TABLE sessions ADD CONSTRAINT sessions_support_grant_fk
  FOREIGN KEY (support_grant_id) REFERENCES support_grants (id) ON DELETE CASCADE;--> statement-breakpoint

-- 5. The audit function learns that an organisation's own id is its organisation.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  record_column text := TG_ARGV[0];
  watched text[] := TG_ARGV[1:TG_NARGS - 1];
  old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  organization_column text := CASE WHEN TG_TABLE_NAME = 'organizations' THEN 'id' ELSE 'organization_id' END;
  old_values jsonb := '{}'::jsonb;
  new_values jsonb := '{}'::jsonb;
  watched_column text;
BEGIN
  FOREACH watched_column IN ARRAY watched LOOP
    IF TG_OP <> 'UPDATE' OR (old_row -> watched_column) IS DISTINCT FROM (new_row -> watched_column) THEN
      old_values := old_values || jsonb_build_object(watched_column, old_row -> watched_column);
      new_values := new_values || jsonb_build_object(watched_column, new_row -> watched_column);
    END IF;
  END LOOP;
  IF new_values = '{}'::jsonb THEN
    RETURN NULL;
  END IF;
  INSERT INTO audit_log (organization_id, actor_member_id, table_name, record_id, action, old_values, new_values)
  VALUES (
    (coalesce(new_row, old_row) ->> organization_column)::uuid,
    nullif(current_setting('app.current_member_id', true), '')::uuid,
    TG_TABLE_NAME,
    coalesce(new_row, old_row) ->> record_column,
    lower(TG_OP)::audit_action,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE old_values END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE new_values END
  );
  RETURN NULL;
END
$$;--> statement-breakpoint

-- 6. Plan, flag and suspension changes, and every step of support access, are audited.
CREATE TRIGGER audit_organization_plan
AFTER UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'plan', 'feature_flags', 'suspended_at', 'suspend_reason');--> statement-breakpoint

CREATE TRIGGER audit_support_grants
AFTER INSERT OR UPDATE ON support_grants
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'reason', 'minutes', 'approved_at', 'declined_at', 'expires_at', 'ended_at');
