-- Opening balances and reconciliation (MVP 2, Sell & Bill, round 6a; spec
-- §3.3, §4.6, §4.7, [PO-5]): rules the tables of 0065 keep.

-- 1. Imported opening balances wait for the go-live: once billing is live
-- they are the record of what was imported, never changed or removed.
REVOKE DELETE, TRUNCATE ON go_live_openings FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION go_live_openings_before_go_live() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sales_settings s
    WHERE s.organization_id = NEW.organization_id AND s.billing_live_on IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'billing is live: opening balances are in the party ledger now'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER go_live_openings_before_go_live
BEFORE INSERT OR UPDATE ON go_live_openings
FOR EACH ROW EXECUTE FUNCTION go_live_openings_before_go_live();--> statement-breakpoint

-- 2. Reconciliation runs and their findings are a permanent record, as the
-- party ledger (0055): tenants may only read and insert.
REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_runs FROM app_tenant;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_findings FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION reconciliation_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: run the reconciliation again instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_append_only
BEFORE UPDATE OR DELETE ON reconciliation_runs
FOR EACH ROW EXECUTE FUNCTION reconciliation_reject_change();--> statement-breakpoint
CREATE TRIGGER reconciliation_runs_no_truncate
BEFORE TRUNCATE ON reconciliation_runs
FOR EACH STATEMENT EXECUTE FUNCTION reconciliation_reject_change();--> statement-breakpoint
CREATE TRIGGER reconciliation_findings_append_only
BEFORE UPDATE OR DELETE ON reconciliation_findings
FOR EACH ROW EXECUTE FUNCTION reconciliation_reject_change();--> statement-breakpoint
CREATE TRIGGER reconciliation_findings_no_truncate
BEFORE TRUNCATE ON reconciliation_findings
FOR EACH STATEMENT EXECUTE FUNCTION reconciliation_reject_change();--> statement-breakpoint

-- 3. Data migration: give existing organisations' owners and admins the new
-- accounting:reconcile permission, matching SYSTEM_ROLES in @paint/shared.
-- Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, 'accounting:reconcile'
FROM roles r
WHERE r.is_system AND r.key IN ('owner', 'org_admin')
ON CONFLICT (role_id, permission) DO NOTHING;
