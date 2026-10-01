-- Loyalty (roadmap P1-M26).

-- 1. The points ledger is a permanent record: entries can be added, never
-- changed or removed. Corrections are adjustments. Tenants may only read and insert.
REVOKE UPDATE, DELETE, TRUNCATE ON loyalty_ledger FROM app_tenant;--> statement-breakpoint

CREATE FUNCTION loyalty_ledger_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'loyalty_ledger is append-only: record an adjustment instead'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint

CREATE TRIGGER loyalty_ledger_append_only
BEFORE UPDATE OR DELETE ON loyalty_ledger
FOR EACH ROW EXECUTE FUNCTION loyalty_ledger_reject_change();--> statement-breakpoint

CREATE TRIGGER loyalty_ledger_no_truncate
BEFORE TRUNCATE ON loyalty_ledger
FOR EACH STATEMENT EXECUTE FUNCTION loyalty_ledger_reject_change();--> statement-breakpoint

-- 2. Audit log (roadmap P1-M20): programme settings, account status, and
-- every manual adjustment of points.
CREATE TRIGGER audit_loyalty_settings
AFTER INSERT OR UPDATE ON loyalty_settings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'earn_points', 'earn_per_paise', 'tiers', 'expiry_days', 'min_redemption_points');--> statement-breakpoint

CREATE TRIGGER audit_loyalty_accounts
AFTER INSERT OR UPDATE ON loyalty_accounts
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status');--> statement-breakpoint

CREATE TRIGGER audit_loyalty_adjustments
AFTER INSERT ON loyalty_ledger
FOR EACH ROW
WHEN (NEW.kind = 'adjust')
EXECUTE FUNCTION audit_row_change('account_id', 'points', 'note');
