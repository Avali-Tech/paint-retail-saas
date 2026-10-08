-- Quotations, sales orders, reservations, dispatches and the go-live cut-over
-- (MVP 2, Sell & Bill, round 4a; spec §3.3, §3.6, §4.1–4.3, §4.7): rules the
-- tables of 0060 keep.

-- 1. A quotation version is edited only while a draft. After that only its
-- status moves on (sent, accepted, superseded, converted) with the matching
-- timestamps; a superseded or converted version is final. Only a draft is
-- deleted. Its lines change only while it is a draft.
CREATE FUNCTION quotations_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['status', 'sent_at', 'accepted_at', 'sales_order_id', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only a draft quotation is deleted'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed)
     OR OLD.status IN ('superseded', 'converted')
     OR NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a sent quotation cannot be changed: revise it as a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER quotations_draft_only
BEFORE UPDATE OR DELETE ON quotations
FOR EACH ROW EXECUTE FUNCTION quotations_draft_only();--> statement-breakpoint
CREATE FUNCTION quotation_lines_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status quotation_status;
BEGIN
  FOR parent_status IN
    SELECT q.status FROM quotations q
    WHERE q.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.quotation_id END,
                   CASE WHEN TG_OP <> 'DELETE' THEN NEW.quotation_id END)
    FOR SHARE
  LOOP
    IF parent_status <> 'draft' THEN
      RAISE EXCEPTION 'lines of a sent quotation cannot be changed'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN coalesce(NEW, OLD);
END
$$;--> statement-breakpoint
CREATE TRIGGER quotation_lines_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON quotation_lines
FOR EACH ROW EXECUTE FUNCTION quotation_lines_draft_only();--> statement-breakpoint

-- 2. A sales order's terms are fixed once confirmed: only its status moves on
-- (and a cancellation is recorded). Cancelled and closed orders are final; a
-- fulfilled order reopens only when one of its invoices is cancelled. Only a
-- draft is deleted. Once confirmed its lines change only in what is billed or
-- cancelled of them, and where they are fulfilled from.
CREATE FUNCTION sales_orders_terms_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['status', 'cancel_reason', 'cancelled_at', 'cancelled_by_member_id',
    'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'only a draft sales order is deleted: cancel it instead'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed)
     OR OLD.status IN ('cancelled', 'closed')
     OR NEW.status = 'draft' THEN
    RAISE EXCEPTION 'a confirmed sales order cannot be changed: cancel lines or the order'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER sales_orders_terms_fixed
BEFORE UPDATE OR DELETE ON sales_orders
FOR EACH ROW EXECUTE FUNCTION sales_orders_terms_fixed();--> statement-breakpoint
CREATE FUNCTION sales_order_lines_terms_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['quantity_invoiced', 'quantity_cancelled', 'fulfil_store_id'];
  parent_status sales_order_status;
BEGIN
  SELECT o.status INTO parent_status FROM sales_orders o
  WHERE o.id = (CASE WHEN TG_OP = 'DELETE' THEN OLD.order_id ELSE NEW.order_id END)
  FOR SHARE;
  -- A draft order (or one being deleted, cascading) changes freely.
  IF parent_status IS NULL OR parent_status = 'draft' THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_OP <> 'UPDATE' OR (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'lines of a confirmed sales order cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER sales_order_lines_terms_fixed
BEFORE INSERT OR UPDATE OR DELETE ON sales_order_lines
FOR EACH ROW EXECUTE FUNCTION sales_order_lines_terms_fixed();--> statement-breakpoint

-- 3. A reservation is history once closed: an open one may only shrink (part
-- of it consumed or released into a closed row of its own) or close, once.
-- Reservations are never deleted.
REVOKE DELETE, TRUNCATE ON stock_reservations FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION stock_reservations_close_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['quantity', 'status', 'consumed_by_type', 'consumed_by_id', 'closed_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a stock reservation is never deleted: release it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'open'
     OR NEW.quantity > OLD.quantity
     OR (NEW.status <> 'open' AND NEW.quantity <> OLD.quantity)
     OR (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'a stock reservation only shrinks or closes, once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER stock_reservations_close_once
BEFORE UPDATE OR DELETE ON stock_reservations
FOR EACH ROW EXECUTE FUNCTION stock_reservations_close_once();--> statement-breakpoint

-- 4. Dispatches are a permanent record of goods leaving: insert only.
REVOKE UPDATE, DELETE, TRUNCATE ON dispatches, dispatch_lines FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION dispatches_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER dispatches_append_only
BEFORE UPDATE OR DELETE ON dispatches
FOR EACH ROW EXECUTE FUNCTION dispatches_reject_change();--> statement-breakpoint
CREATE TRIGGER dispatch_lines_append_only
BEFORE UPDATE OR DELETE ON dispatch_lines
FOR EACH ROW EXECUTE FUNCTION dispatches_reject_change();--> statement-breakpoint

-- 5. Go-live (spec §4.7): billing_live_on is set once and never moved; after
-- it the hand-entered exposure and overdue days of every credit profile are
-- read-only (exposure comes from the party ledger).
CREATE FUNCTION sales_settings_live_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.billing_live_on IS NOT NULL AND NEW.billing_live_on IS DISTINCT FROM OLD.billing_live_on THEN
    RAISE EXCEPTION 'billing went live on %; that date never changes', OLD.billing_live_on
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER sales_settings_live_once
BEFORE UPDATE ON sales_settings
FOR EACH ROW EXECUTE FUNCTION sales_settings_live_once();--> statement-breakpoint
CREATE FUNCTION credit_profiles_manual_until_live() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.manual_exposure_paise IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.manual_exposure_paise ELSE 0 END)
      OR NEW.overdue_days IS DISTINCT FROM (CASE WHEN TG_OP = 'UPDATE' THEN OLD.overdue_days ELSE 0 END))
     AND EXISTS (
       SELECT 1 FROM sales_settings s
       WHERE s.organization_id = NEW.organization_id AND s.billing_live_on IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'billing is live: what a party owes comes from its ledger now'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER credit_profiles_manual_until_live
BEFORE INSERT OR UPDATE ON credit_profiles
FOR EACH ROW EXECUTE FUNCTION credit_profiles_manual_until_live();--> statement-breakpoint

-- 6. Audit log: every quotation version and status change, every order's
-- status change and credit override (spec §4.4: "recorded on the order"),
-- every dispatch, and the opening overdue date set at go-live.
CREATE TRIGGER audit_quotations
AFTER INSERT OR UPDATE ON quotations
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'number', 'version', 'status', 'total_paise', 'valid_until');--> statement-breakpoint
CREATE TRIGGER audit_sales_orders
AFTER INSERT OR UPDATE ON sales_orders
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'number', 'status', 'payment_terms', 'total_paise', 'credit_check', 'credit_override_approval', 'credit_override_by_member_id', 'credit_override_reason', 'cancel_reason');--> statement-breakpoint
CREATE TRIGGER audit_dispatches
AFTER INSERT ON dispatches
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'number', 'invoice_id', 'eway_bill_no', 'value_paise');--> statement-breakpoint
DROP TRIGGER audit_credit_profiles ON credit_profiles;--> statement-breakpoint
CREATE TRIGGER audit_credit_profiles
AFTER INSERT OR UPDATE ON credit_profiles
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status', 'limit_paise', 'credit_days', 'hold_reason', 'opening_overdue_since');
