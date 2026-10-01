-- Audit log (roadmap P1-M20) for credit (P1-M25): every change to a party's
-- credit limit, days, status and hold reason, and to the business's credit rules.
CREATE TRIGGER audit_credit_profiles
AFTER INSERT OR UPDATE ON credit_profiles
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status', 'limit_paise', 'credit_days', 'hold_reason');--> statement-breakpoint

CREATE TRIGGER audit_credit_rules
AFTER INSERT OR UPDATE ON credit_rules
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'normal_up_to_percent', 'manager_up_to_percent', 'hold_after_overdue_days');
