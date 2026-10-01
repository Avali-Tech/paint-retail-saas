-- Audit log (roadmap P1-M20): sensitive tables record every change through a
-- trigger, so no code path can skip it. The application can only read the log.

-- 1. Tenants may only read; rows are written by the trigger function below.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_log FROM app_tenant;--> statement-breakpoint

-- 2. Nobody may change or remove an entry, whatever their role.
CREATE FUNCTION audit_log_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint

CREATE TRIGGER audit_log_append_only
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();--> statement-breakpoint

CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();--> statement-breakpoint

-- 3. Records one row change. Arguments: the column that identifies the record,
-- then the columns worth auditing. Updates are logged only when one of those
-- columns changed, with just the changed ones. The actor is the member set by
-- the API for the transaction (app.current_member_id); none means system work.
-- SECURITY DEFINER lets it write to audit_log, which tenants cannot.
CREATE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  record_column text := TG_ARGV[0];
  watched text[] := TG_ARGV[1:TG_NARGS - 1];
  old_row jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
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
    (coalesce(new_row, old_row) ->> 'organization_id')::uuid,
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

-- 4. What is audited. Prices change on update (new products are not changes).
CREATE TRIGGER audit_product_prices
AFTER UPDATE ON product_variants
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'mrp_paise', 'selling_price_paise');--> statement-breakpoint

CREATE TRIGGER audit_roles
AFTER INSERT OR UPDATE OR DELETE ON roles
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'key', 'name');--> statement-breakpoint

CREATE TRIGGER audit_role_permissions
AFTER INSERT OR DELETE ON role_permissions
FOR EACH ROW EXECUTE FUNCTION audit_row_change('role_id', 'permission');--> statement-breakpoint

CREATE TRIGGER audit_member_access
AFTER INSERT OR UPDATE OR DELETE ON organization_members
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'role_id', 'all_stores', 'is_active');--> statement-breakpoint

CREATE TRIGGER audit_member_stores
AFTER INSERT OR DELETE ON member_stores
FOR EACH ROW EXECUTE FUNCTION audit_row_change('member_id', 'store_id');--> statement-breakpoint

CREATE TRIGGER audit_stock_adjustments
AFTER INSERT ON stock_ledger
FOR EACH ROW
WHEN (NEW.movement_type IN ('adjustment', 'damage', 'count_correction'))
EXECUTE FUNCTION audit_row_change('id', 'store_id', 'variant_id', 'movement_type', 'quantity', 'note');--> statement-breakpoint

-- 5. Data migration: owners and admins of existing businesses can read the log.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, 'audit:read'
FROM roles r
WHERE r.is_system AND r.key IN ('owner', 'org_admin')
ON CONFLICT (role_id, permission) DO NOTHING;
