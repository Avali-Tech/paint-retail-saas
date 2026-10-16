-- SaaS subscriptions (roadmap P2-M08; docs/mvp-3/subscriptions.md): rules the
-- tables of 0077 keep.

-- 1. A business reads its own subscription, plan history, checkouts, plan requests,
-- our invoices and the payments recorded against them (row-level security); it
-- never writes them. The platform does, after checking that an owner asked, that a
-- platform operator recorded a payment, or that the gateway's signature is good.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON subscriptions, subscription_plan_changes, subscription_checkouts, subscription_invoices,
     subscription_payments, subscription_plan_requests
  FROM app_tenant;--> statement-breakpoint

-- 2. The invoice series and the gateway's events are the platform's alone.
REVOKE ALL ON subscription_invoice_sequences, payment_gateway_events FROM app_tenant;--> statement-breakpoint

-- 3. Plan history, issued invoices and recorded payments are a permanent record.
CREATE FUNCTION subscription_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is a permanent record and cannot be changed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER subscription_plan_changes_append_only
BEFORE UPDATE OR DELETE ON subscription_plan_changes
FOR EACH ROW EXECUTE FUNCTION subscription_reject_change();--> statement-breakpoint
CREATE TRIGGER subscription_plan_changes_no_truncate
BEFORE TRUNCATE ON subscription_plan_changes
FOR EACH STATEMENT EXECUTE FUNCTION subscription_reject_change();--> statement-breakpoint
CREATE TRIGGER subscription_invoices_append_only
BEFORE UPDATE OR DELETE ON subscription_invoices
FOR EACH ROW EXECUTE FUNCTION subscription_reject_change();--> statement-breakpoint
CREATE TRIGGER subscription_invoices_no_truncate
BEFORE TRUNCATE ON subscription_invoices
FOR EACH STATEMENT EXECUTE FUNCTION subscription_reject_change();--> statement-breakpoint
CREATE TRIGGER subscription_payments_append_only
BEFORE UPDATE OR DELETE ON subscription_payments
FOR EACH ROW EXECUTE FUNCTION subscription_reject_change();--> statement-breakpoint
CREATE TRIGGER subscription_payments_no_truncate
BEFORE TRUNCATE ON subscription_payments
FOR EACH STATEMENT EXECUTE FUNCTION subscription_reject_change();--> statement-breakpoint

-- 4. A payment settles a manual invoice only, of the same business, for no more
-- than its total.
CREATE FUNCTION subscription_payment_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  invoice subscription_invoices%ROWTYPE;
BEGIN
  SELECT * INTO invoice FROM subscription_invoices
  WHERE id = NEW.invoice_id AND organization_id = NEW.organization_id;
  IF invoice.gateway <> 'manual' THEN
    RAISE EXCEPTION 'invoice % was paid at the gateway', invoice.number
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.amount_paise > invoice.total_paise THEN
    RAISE EXCEPTION 'a payment cannot exceed the invoice total (%)', invoice.total_paise
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER subscription_payments_check
BEFORE INSERT ON subscription_payments
FOR EACH ROW EXECUTE FUNCTION subscription_payment_check();--> statement-breakpoint

-- 5. A plan request is decided once: open, then applied or cancelled, never back.
CREATE FUNCTION subscription_plan_request_decided_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'open'
    OR NEW.organization_id <> OLD.organization_id OR NEW.plan <> OLD.plan
    OR NEW.billing_interval <> OLD.billing_interval
    OR NEW.requested_by_member_id <> OLD.requested_by_member_id
    OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a plan request is decided once and never changed afterwards'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER subscription_plan_requests_decided_once
BEFORE UPDATE ON subscription_plan_requests
FOR EACH ROW EXECUTE FUNCTION subscription_plan_request_decided_once();--> statement-breakpoint

-- 6. How a subscription moves, and what is asked and paid for it, is in the
-- business's audit log, as plan changes are (0028).
CREATE TRIGGER audit_subscriptions
AFTER INSERT OR UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'status', 'billing_interval', 'store_quantity', 'trial_ends_at', 'current_period_end', 'cancel_at_period_end', 'past_due_since', 'gateway');--> statement-breakpoint
CREATE TRIGGER audit_subscription_payments
AFTER INSERT ON subscription_payments
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'invoice_id', 'amount_paise', 'paid_on', 'mode', 'reference', 'recorded_by_user_id');--> statement-breakpoint
CREATE TRIGGER audit_subscription_plan_requests
AFTER INSERT OR UPDATE ON subscription_plan_requests
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'plan', 'billing_interval', 'status', 'decided_by_user_id');--> statement-breakpoint

-- 7. Data migration: every existing business gets its subscription. A trial
-- starts a fresh 14-day trial (the default SUBSCRIPTION_TRIAL_DAYS); a plan the
-- platform set by hand stays active, invoiced outside the product, until the owner
-- asks for a plan and an operator applies it (or the owner pays online, with a
-- gateway). Safe to re-run.
INSERT INTO subscriptions (organization_id, status, trial_ends_at)
SELECT o.id,
  (CASE WHEN o.plan = 'trial' THEN 'trialing' ELSE 'active' END)::subscription_status,
  CASE WHEN o.plan = 'trial' THEN now() + interval '14 days' END
FROM organizations o
ON CONFLICT (organization_id) DO NOTHING;
