-- Each business's own gateway account and gateway refunds (MVP 3 round 4c, P2-M32;
-- docs/mvp-3/payment-links.md, spec §6.2 PL-13 – PL-18): rules the tables of 0081 keep.
-- The value 0081 added to notification_event is not named here: migrations run in one
-- transaction, and a value added to an enum cannot be used in it. No data migration:
-- every business starts with no gateway account and the default link settings.

-- 1. A gateway account belongs to its business for good: its gateway and the webhook
-- reference in its URL never change (reconnecting keeps the URL the shop pasted at the
-- gateway). Tenants never delete one: disconnecting clears the credentials.
REVOKE DELETE, TRUNCATE ON payment_gateway_accounts FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION payment_gateway_accounts_keep_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a gateway account is never deleted: disconnect it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.gateway IS DISTINCT FROM OLD.gateway
     OR NEW.webhook_ref IS DISTINCT FROM OLD.webhook_ref THEN
    RAISE EXCEPTION 'a gateway account keeps its business, gateway and webhook reference'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER payment_gateway_accounts_keep_identity
BEFORE UPDATE OR DELETE ON payment_gateway_accounts
FOR EACH ROW EXECUTE FUNCTION payment_gateway_accounts_keep_identity();--> statement-breakpoint

-- Audited (who connected, replaced or disconnected the keys, and when), never with a
-- secret: the sealed credentials and the secrets' hints are not watched columns.
CREATE TRIGGER audit_payment_gateway_accounts
AFTER INSERT OR UPDATE ON payment_gateway_accounts
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'gateway', 'key_id_hint', 'live', 'connected_at', 'connected_by_member_id');--> statement-breakpoint

-- 2. A gateway refund keeps what it refunds and how much. Its status moves forward
-- only: pending → pending (another try), refunded, failed or dropped; refunded →
-- returned (the gateway failed it after taking it). The gateway's refund id and the
-- refund payment are written once. Tenants never delete one.
REVOKE DELETE, TRUNCATE ON payment_link_refunds FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION payment_link_refunds_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  moving text[] := ARRAY['status', 'gateway_refund_id', 'gateway_status', 'refund_payment_id',
    'returned_payment_id', 'attempts', 'next_attempt_at', 'last_error', 'flagged_at',
    'refunded_at', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a gateway refund is never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'a gateway refund keeps what it refunds and how much'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'pending' AND NEW.status IN ('refunded', 'failed', 'dropped'))
    OR (OLD.status = 'refunded' AND NEW.status = 'returned')
  ) THEN
    RAISE EXCEPTION 'a % gateway refund cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('failed', 'dropped', 'returned') AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'a % gateway refund is closed', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD.gateway_refund_id IS NOT NULL AND NEW.gateway_refund_id IS DISTINCT FROM OLD.gateway_refund_id)
     OR (OLD.refund_payment_id IS NOT NULL AND NEW.refund_payment_id IS DISTINCT FROM OLD.refund_payment_id)
     OR NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'a gateway refund''s id and refund payment are written once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER payment_link_refunds_forward_only
BEFORE UPDATE OR DELETE ON payment_link_refunds
FOR EACH ROW EXECUTE FUNCTION payment_link_refunds_forward_only();--> statement-breakpoint

-- Audit log (roadmap P1-M20): a refund sends a customer's money back.
CREATE TRIGGER audit_payment_link_refunds
AFTER INSERT OR UPDATE ON payment_link_refunds
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'link_id', 'payment_id', 'amount_paise', 'reason', 'status', 'gateway_refund_id', 'refund_payment_id', 'returned_payment_id');--> statement-breakpoint

-- 3. The payment-link settings of 0081 are audited like every other sales setting.
DROP TRIGGER audit_sales_settings ON sales_settings;--> statement-breakpoint
CREATE TRIGGER audit_sales_settings
AFTER INSERT OR UPDATE ON sales_settings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'stock_post_on', 'walk_in_party_id', 'quote_validity_days', 'partial_min_advance_pct', 'default_price_mode', 'billing_live_on', 'cash_needs_register', 'register_variance_alert_paise', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id', 'invoice_terms', 'payment_link_validity_minutes', 'payment_link_cap_paise', 'payment_link_amount_basis');
