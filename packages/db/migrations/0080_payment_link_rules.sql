-- UPI payment links (MVP 3 round 4a, P2-M32; docs/mvp-3/credit-and-receivables.md
-- §6.2): rules the tables of 0079 keep. The new enum values of 0079 (payment_mode_kind
-- 'upi_link', payment_gateway 'log') are not named here: migrations run in one
-- transaction, and a value added to an enum cannot be used in it.

-- 1. A link keeps what it asked for. Only its status and what was paid change, and
-- only forward: created → paid, expired or cancelled; expired or cancelled → paid (the
-- money came anyway, and is recorded); paid is final. What was paid only grows; the
-- moment it was paid or cancelled is written once. Tenants never delete a link.
REVOKE DELETE, TRUNCATE ON payment_links FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION payment_links_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  moving text[] := ARRAY['status', 'paid_paise', 'paid_at', 'cancelled_at', 'cancelled_by_member_id', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment link is never deleted: cancel it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'a payment link keeps what it asked for: create a new one instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'created' AND NEW.status IN ('paid', 'expired', 'cancelled'))
    OR (OLD.status IN ('expired', 'cancelled') AND NEW.status = 'paid')
  ) THEN
    RAISE EXCEPTION 'a % payment link cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.paid_paise < OLD.paid_paise
     OR (OLD.paid_at IS NOT NULL AND NEW.paid_at IS DISTINCT FROM OLD.paid_at)
     OR (OLD.cancelled_at IS NOT NULL AND (NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.cancelled_by_member_id IS DISTINCT FROM OLD.cancelled_by_member_id)) THEN
    RAISE EXCEPTION 'what was paid on a payment link only grows; paid and cancelled are written once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER payment_links_forward_only
BEFORE UPDATE OR DELETE ON payment_links
FOR EACH ROW EXECUTE FUNCTION payment_links_forward_only();--> statement-breakpoint

-- 2. The documents a link pays are written with it and never change.
REVOKE UPDATE, DELETE, TRUNCATE ON payment_link_documents FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION payment_link_documents_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment_link_documents is append-only'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER payment_link_documents_append_only
BEFORE UPDATE OR DELETE ON payment_link_documents
FOR EACH ROW EXECUTE FUNCTION payment_link_documents_reject_change();--> statement-breakpoint
CREATE TRIGGER payment_link_documents_no_truncate
BEFORE TRUNCATE ON payment_link_documents
FOR EACH STATEMENT EXECUTE FUNCTION payment_link_documents_reject_change();--> statement-breakpoint

-- 3. Audit log (roadmap P1-M20): a link asks a customer for money.
CREATE TRIGGER audit_payment_links
AFTER INSERT OR UPDATE ON payment_links
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'number', 'party_id', 'purpose', 'amount_paise', 'expires_at', 'status', 'paid_paise', 'cancelled_by_member_id');
