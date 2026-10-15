-- SaaS subscriptions (roadmap P2-M08; docs/mvp-2/subscriptions.md): rules the
-- tables of 0069 keep.

-- 1. A business reads its own subscription, plan history, checkouts and our
-- invoices (row-level security); it never writes them. The platform does, after
-- checking that an owner asked or that the gateway's signature is good.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON subscriptions, subscription_plan_changes, subscription_checkouts, subscription_invoices
  FROM app_tenant;--> statement-breakpoint

-- 2. The invoice series and the gateway's events are the platform's alone.
REVOKE ALL ON subscription_invoice_sequences, payment_gateway_events FROM app_tenant;--> statement-breakpoint

-- 3. Plan history and issued invoices are a permanent record.
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

-- 4. How a subscription moves is in the business's audit log, as plan changes are (0028).
CREATE TRIGGER audit_subscriptions
AFTER INSERT OR UPDATE ON subscriptions
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'status', 'billing_interval', 'store_quantity', 'trial_ends_at', 'current_period_end', 'cancel_at_period_end', 'past_due_since', 'gateway');--> statement-breakpoint

-- 5. Data migration: every existing business gets its subscription. A trial
-- starts a fresh 14-day trial (the default SUBSCRIPTION_TRIAL_DAYS); a plan the
-- platform set by hand stays active, invoiced outside the product, until the owner
-- pays through the gateway. Safe to re-run.
INSERT INTO subscriptions (organization_id, status, trial_ends_at)
SELECT o.id,
  (CASE WHEN o.plan = 'trial' THEN 'trialing' ELSE 'active' END)::subscription_status,
  CASE WHEN o.plan = 'trial' THEN now() + interval '14 days' END
FROM organizations o
ON CONFLICT (organization_id) DO NOTHING;
