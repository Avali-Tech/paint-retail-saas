-- Payments, allocations and the cash register (MVP 2, Sell & Bill, round 3a;
-- spec §3.3, §3.6, §4.6, §5.5): rules the tables of 0057 keep.

-- 1. A payment is never edited or deleted. The only change: a received
-- cheque's status, once, from pending to cleared or bounced (with its date and
-- the bank's reason). A bounce is undone in the ledger and allocations, not here.
REVOKE DELETE, TRUNCATE ON payments FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION payments_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['cheque_status', 'cheque_cleared_on', 'cheque_bounced_on', 'bounce_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment is never deleted: refund it or bounce the cheque'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed)
     OR OLD.cheque_status IS DISTINCT FROM 'pending'
     OR NEW.cheque_status IS NULL OR NEW.cheque_status = 'pending' THEN
    RAISE EXCEPTION 'a payment cannot be changed: only a pending cheque clears or bounces, once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER payments_immutable
BEFORE UPDATE OR DELETE ON payments
FOR EACH ROW EXECUTE FUNCTION payments_immutable();--> statement-breakpoint

-- 2. Cash goes only into an open register session (at its own store, by the
-- foreign key). The share lock makes a closing session wait for the payment.
CREATE FUNCTION payments_session_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.register_session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM register_sessions s
    WHERE s.id = NEW.register_session_id AND s.status = 'open'
    FOR SHARE
  ) THEN
    RAISE EXCEPTION 'this register session is closed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER payments_session_open
BEFORE INSERT ON payments
FOR EACH ROW EXECUTE FUNCTION payments_session_open();--> statement-breakpoint

-- 3. Allocations are append-only; a negative row undoes an earlier one. Every
-- row keeps its source (payment or credit note) and target (document, ledger
-- entry or refund) within their amounts. Rows of one party are written one at
-- a time (its party_balances row is locked), so two allocations racing for the
-- same outstanding amount cannot both take it.
REVOKE UPDATE, DELETE, TRUNCATE ON allocations FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION allocations_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'allocations are append-only: add a reversing row instead'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER allocations_append_only
BEFORE UPDATE OR DELETE ON allocations
FOR EACH ROW EXECUTE FUNCTION allocations_reject_change();--> statement-breakpoint
CREATE TRIGGER allocations_no_truncate
BEFORE TRUNCATE ON allocations
FOR EACH STATEMENT EXECUTE FUNCTION allocations_reject_change();--> statement-breakpoint
CREATE FUNCTION allocations_within_amounts() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  original allocations%ROWTYPE;
  target_total bigint;
  target_used bigint;
  source_total bigint;
  source_used bigint;
  doc_kind tax_document_kind;
  doc_status tax_document_status;
  ledger_type party_ledger_entry_type;
  pay_direction payment_direction;
  pay_cheque cheque_status;
BEGIN
  PERFORM 1 FROM party_balances b WHERE b.party_id = NEW.party_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this party has nothing to allocate against'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.reverses_allocation_id IS NOT NULL THEN
    SELECT * INTO original FROM allocations a WHERE a.id = NEW.reverses_allocation_id;
    IF original.reverses_allocation_id IS NOT NULL OR original.refund_payment_id IS NOT NULL
       OR NEW.amount_paise <> -original.amount_paise
       OR (NEW.party_id, NEW.payment_id, NEW.credit_note_id, NEW.document_id, NEW.party_ledger_id)
          IS DISTINCT FROM
          (original.party_id, original.payment_id, original.credit_note_id, original.document_id,
           original.party_ledger_id) THEN
      RAISE EXCEPTION 'a reversal must undo exactly one allocation to a document'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- The target: what is still owed on it.
  IF NEW.document_id IS NOT NULL THEN
    SELECT d.kind, d.status, d.total_paise INTO doc_kind, doc_status, target_total
    FROM tax_documents d WHERE d.id = NEW.document_id FOR SHARE;
    IF doc_status <> 'issued' OR doc_kind NOT IN ('invoice', 'bill_of_supply', 'debit_note') THEN
      RAISE EXCEPTION 'only an issued invoice, bill of supply or debit note can be paid'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a.amount_paise), 0) INTO target_used
    FROM allocations a WHERE a.document_id = NEW.document_id;
  ELSIF NEW.party_ledger_id IS NOT NULL THEN
    SELECT l.entry_type, l.amount_paise INTO ledger_type, target_total
    FROM party_ledger l WHERE l.id = NEW.party_ledger_id;
    IF ledger_type NOT IN ('opening', 'adjustment') OR target_total <= 0 THEN
      RAISE EXCEPTION 'only an opening balance or a charge the party owes can be paid'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a.amount_paise), 0) INTO target_used
    FROM allocations a WHERE a.party_ledger_id = NEW.party_ledger_id;
  ELSE
    SELECT p.direction, p.amount_paise INTO pay_direction, target_total
    FROM payments p WHERE p.id = NEW.refund_payment_id;
    IF pay_direction <> 'out' THEN
      RAISE EXCEPTION 'money is paid back only by a refund'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a.amount_paise), 0) INTO target_used
    FROM allocations a WHERE a.refund_payment_id = NEW.refund_payment_id;
  END IF;
  IF target_used + NEW.amount_paise > target_total THEN
    RAISE EXCEPTION 'more than is outstanding' USING ERRCODE = 'check_violation';
  END IF;

  -- The source: what is left of it.
  IF NEW.payment_id IS NOT NULL THEN
    SELECT p.direction, p.amount_paise, p.cheque_status INTO pay_direction, source_total, pay_cheque
    FROM payments p WHERE p.id = NEW.payment_id FOR SHARE;
    IF pay_direction <> 'in' OR pay_cheque IS NOT DISTINCT FROM 'bounced' THEN
      RAISE EXCEPTION 'only money received, and not bounced, can be allocated'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.refund_payment_id IS NOT NULL AND pay_cheque IS NOT DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'a cheque is refunded only after it clears'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a.amount_paise), 0) INTO source_used
    FROM allocations a WHERE a.payment_id = NEW.payment_id;
  ELSE
    SELECT d.kind, d.status, d.total_paise INTO doc_kind, doc_status, source_total
    FROM tax_documents d WHERE d.id = NEW.credit_note_id FOR SHARE;
    IF doc_status <> 'issued' OR doc_kind <> 'credit_note' THEN
      RAISE EXCEPTION 'only an issued credit note can be allocated'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT coalesce(sum(a.amount_paise), 0) INTO source_used
    FROM allocations a WHERE a.credit_note_id = NEW.credit_note_id;
  END IF;
  IF source_used + NEW.amount_paise > source_total THEN
    RAISE EXCEPTION 'more than is left to allocate' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER allocations_within_amounts
BEFORE INSERT ON allocations
FOR EACH ROW EXECUTE FUNCTION allocations_within_amounts();--> statement-breakpoint

-- 4. A document with money against it is not cancelled (spec §3.6): undo the
-- allocations first, or raise a credit note.
CREATE FUNCTION tax_documents_unpaid_to_cancel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status = 'issued' AND (
    (SELECT coalesce(sum(a.amount_paise), 0) FROM allocations a WHERE a.document_id = NEW.id) <> 0
    OR (SELECT coalesce(sum(a.amount_paise), 0) FROM allocations a WHERE a.credit_note_id = NEW.id) <> 0
  ) THEN
    RAISE EXCEPTION 'a paid document cannot be cancelled'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER tax_documents_unpaid_to_cancel
BEFORE UPDATE ON tax_documents
FOR EACH ROW EXECUTE FUNCTION tax_documents_unpaid_to_cancel();--> statement-breakpoint

-- 5. A register session is opened, then closed once; never changed after,
-- never deleted. Cash movements are added only while it is open, and never
-- changed.
REVOKE DELETE, TRUNCATE ON register_sessions FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION register_sessions_close_once() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['status', 'closed_by_member_id', 'closed_at', 'expected_cash_paise',
    'counted_cash_paise', 'variance_paise', 'denominations', 'closing_note', 'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a register session is never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'closed' OR NEW.status <> 'closed'
     OR (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed) THEN
    RAISE EXCEPTION 'a register session only closes, once; a closed session never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER register_sessions_close_once
BEFORE UPDATE OR DELETE ON register_sessions
FOR EACH ROW EXECUTE FUNCTION register_sessions_close_once();--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON register_cash_movements FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION register_cash_movements_while_open() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'register cash movements are append-only'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM register_sessions s WHERE s.id = NEW.session_id AND s.status = 'open' FOR SHARE
  ) THEN
    RAISE EXCEPTION 'this register session is closed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER register_cash_movements_while_open
BEFORE INSERT OR UPDATE OR DELETE ON register_cash_movements
FOR EACH ROW EXECUTE FUNCTION register_cash_movements_while_open();--> statement-breakpoint

-- 6. An accounting export is a record of what was sent: it never changes,
-- except filing its file once.
REVOKE DELETE, TRUNCATE ON accounting_exports FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION accounting_exports_file_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.document_id IS NOT NULL
     OR (to_jsonb(NEW) - 'document_id') IS DISTINCT FROM (to_jsonb(OLD) - 'document_id') THEN
    RAISE EXCEPTION 'an accounting export never changes, except filing its file once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER accounting_exports_file_once
BEFORE UPDATE OR DELETE ON accounting_exports
FOR EACH ROW EXECUTE FUNCTION accounting_exports_file_once();--> statement-breakpoint

-- 7. Audit log: payment modes and ledger mappings (settings), the two new
-- selling settings, each register session's open and close, a cheque's
-- clearing or bounce, and every accounting export.
CREATE TRIGGER audit_payment_modes
AFTER INSERT OR UPDATE ON payment_modes
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'kind', 'name', 'is_active');--> statement-breakpoint
CREATE TRIGGER audit_ledger_mappings
AFTER INSERT OR UPDATE OR DELETE ON ledger_mappings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'purpose', 'rate_bps', 'nature', 'supply_type', 'store_id', 'mode_kind', 'mode_id', 'party_id', 'tally_ledger_name', 'tally_group', 'position');--> statement-breakpoint
DROP TRIGGER audit_sales_settings ON sales_settings;--> statement-breakpoint
CREATE TRIGGER audit_sales_settings
AFTER INSERT OR UPDATE ON sales_settings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'stock_post_on', 'walk_in_party_id', 'quote_validity_days', 'partial_min_advance_pct', 'default_price_mode', 'billing_live_on', 'cash_needs_register', 'register_variance_alert_paise');--> statement-breakpoint
CREATE TRIGGER audit_register_sessions
AFTER INSERT OR UPDATE ON register_sessions
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status', 'register_code', 'opening_float_paise', 'expected_cash_paise', 'counted_cash_paise', 'variance_paise');--> statement-breakpoint
CREATE TRIGGER audit_payments
AFTER UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'cheque_status', 'bounce_reason');--> statement-breakpoint
CREATE TRIGGER audit_accounting_exports
AFTER INSERT ON accounting_exports
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'period_from', 'period_to', 'kinds', 'format');
