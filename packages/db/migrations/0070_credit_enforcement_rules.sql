-- Credit enforcement (MVP 3 round 1a, P2-M09; docs/mvp-3/credit-and-receivables.md
-- §3.2, §4): rules the tables and columns of 0069 keep.

-- 1. An approval moves only forward: pending → approved / rejected / cancelled,
-- approved → used / cancelled. What was asked (party, subject, level, amount,
-- check, reason, requester) never changes; a decision is written once.
REVOKE TRUNCATE ON credit_approvals FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION credit_approvals_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  decided text[] := ARRAY['status', 'decided_by_member_id', 'decided_at', 'decision_reason',
    'waive_overdue_until', 'used_at'];
BEGIN
  IF (to_jsonb(NEW) - decided) IS DISTINCT FROM (to_jsonb(OLD) - decided) THEN
    RAISE EXCEPTION 'a credit approval keeps what was asked: ask again instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status IN ('used', 'cancelled')
        AND NEW.decided_by_member_id IS NOT DISTINCT FROM OLD.decided_by_member_id
        AND NEW.decided_at IS NOT DISTINCT FROM OLD.decided_at
        AND NEW.decision_reason IS NOT DISTINCT FROM OLD.decision_reason
        AND NEW.waive_overdue_until IS NOT DISTINCT FROM OLD.waive_overdue_until)
  ) THEN
    RAISE EXCEPTION 'a % credit approval cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER credit_approvals_forward_only
BEFORE UPDATE ON credit_approvals
FOR EACH ROW EXECUTE FUNCTION credit_approvals_forward_only();--> statement-breakpoint

-- 2. The nightly overdue checks are a permanent record, like reconciliation runs
-- (0066): tenants may only read and insert.
REVOKE UPDATE, DELETE, TRUNCATE ON credit_hold_runs FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION credit_hold_runs_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_hold_runs is append-only'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER credit_hold_runs_append_only
BEFORE UPDATE OR DELETE ON credit_hold_runs
FOR EACH ROW EXECUTE FUNCTION credit_hold_runs_reject_change();--> statement-breakpoint
CREATE TRIGGER credit_hold_runs_no_truncate
BEFORE TRUNCATE ON credit_hold_runs
FOR EACH STATEMENT EXECUTE FUNCTION credit_hold_runs_reject_change();--> statement-breakpoint

-- (Once billing is live the hand-entered figures are already frozen by
-- credit_profiles_manual_until_live, 0061.)

-- 3. Audit log (roadmap P1-M20): who asked for and decided each approval, site
-- limits and holds, the new hold columns, and the approval an order or invoice used.
CREATE TRIGGER audit_credit_approvals
AFTER INSERT OR UPDATE OR DELETE ON credit_approvals
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'number', 'kind', 'party_id', 'sales_order_id', 'tax_document_id', 'level', 'amount_paise', 'reason', 'status', 'decided_by_member_id', 'decision_reason', 'waive_overdue_until');--> statement-breakpoint
CREATE TRIGGER audit_site_credit_accounts
AFTER INSERT OR UPDATE ON site_credit_accounts
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'party_id', 'project_id', 'limit_paise', 'status', 'hold_reason');--> statement-breakpoint
DROP TRIGGER audit_credit_profiles ON credit_profiles;--> statement-breakpoint
CREATE TRIGGER audit_credit_profiles
AFTER INSERT OR UPDATE ON credit_profiles
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status', 'limit_paise', 'credit_days', 'hold_reason', 'opening_overdue_since', 'hold_kind', 'overdue_waived_until');--> statement-breakpoint
DROP TRIGGER audit_sales_orders ON sales_orders;--> statement-breakpoint
CREATE TRIGGER audit_sales_orders
AFTER INSERT OR UPDATE ON sales_orders
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'number', 'status', 'payment_terms', 'total_paise', 'credit_check', 'credit_override_approval', 'credit_override_by_member_id', 'credit_override_reason', 'credit_approval_id', 'cancel_reason');--> statement-breakpoint
DROP TRIGGER audit_tax_documents ON tax_documents;--> statement-breakpoint
CREATE TRIGGER audit_tax_documents
AFTER UPDATE ON tax_documents
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status', 'number', 'cancel_reason', 'irn', 'ack_no', 'credit_approval_id');
