-- Tax documents (MVP 2, Sell & Bill; spec §3.6): rules the tables of 0054 keep.

-- 1. An issued document is never edited or deleted. The only changes allowed:
-- cancelling it (status, reason, when and by whom), filling the e-invoice
-- columns once, and the ITC reversal status of a note. A cancelled document is
-- final. Corrections are new documents (credit and debit notes).
REVOKE TRUNCATE ON tax_documents, tax_document_lines, tax_document_tax_rows, tax_document_links FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION tax_documents_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed text[] := ARRAY['updated_at', 'status', 'cancel_reason', 'cancelled_at',
    'cancelled_by_member_id', 'irn', 'ack_no', 'ack_at', 'signed_qr', 'itc_reversal_status'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'an issued tax document is never deleted: cancel it or raise a note'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - allowed) IS DISTINCT FROM (to_jsonb(OLD) - allowed)
     OR NEW.status = 'draft'
     OR (OLD.status = 'cancelled'
         AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at'))
     OR (OLD.irn IS NOT NULL AND NEW.irn IS DISTINCT FROM OLD.irn)
     OR (OLD.ack_no IS NOT NULL AND NEW.ack_no IS DISTINCT FROM OLD.ack_no)
     OR (OLD.ack_at IS NOT NULL AND NEW.ack_at IS DISTINCT FROM OLD.ack_at)
     OR (OLD.signed_qr IS NOT NULL AND NEW.signed_qr IS DISTINCT FROM OLD.signed_qr) THEN
    RAISE EXCEPTION 'an issued tax document cannot be changed: cancel it or raise a note'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER tax_documents_immutable
BEFORE UPDATE OR DELETE ON tax_documents
FOR EACH ROW EXECUTE FUNCTION tax_documents_immutable();--> statement-breakpoint

-- 2. Lines, tax rows and links change only while their document is a draft.
-- Argument: the column holding the document's id. A document already gone (a
-- draft being deleted, cascading) allows the change.
CREATE FUNCTION tax_document_children_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_column text := TG_ARGV[0];
  parent_ids uuid[] := ARRAY[]::uuid[];
  parent_status tax_document_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    parent_ids := parent_ids || (to_jsonb(OLD) ->> parent_column)::uuid;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    parent_ids := parent_ids || (to_jsonb(NEW) ->> parent_column)::uuid;
  END IF;
  FOR parent_status IN
    SELECT d.status FROM tax_documents d WHERE d.id = ANY (parent_ids) FOR SHARE
  LOOP
    IF parent_status <> 'draft' THEN
      RAISE EXCEPTION '% of an issued tax document cannot be changed', TG_TABLE_NAME
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN coalesce(NEW, OLD);
END
$$;--> statement-breakpoint
CREATE TRIGGER tax_document_lines_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON tax_document_lines
FOR EACH ROW EXECUTE FUNCTION tax_document_children_draft_only('document_id');--> statement-breakpoint
CREATE TRIGGER tax_document_tax_rows_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON tax_document_tax_rows
FOR EACH ROW EXECUTE FUNCTION tax_document_children_draft_only('document_id');--> statement-breakpoint
CREATE TRIGGER tax_document_links_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON tax_document_links
FOR EACH ROW EXECUTE FUNCTION tax_document_children_draft_only('from_document_id');--> statement-breakpoint

-- 3. The party ledger is a permanent record, as the stock ledger (0009):
-- tenants may only read and insert; corrections are new entries.
REVOKE UPDATE, DELETE, TRUNCATE ON party_ledger FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION party_ledger_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'party_ledger is append-only: record a correcting entry instead'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER party_ledger_append_only
BEFORE UPDATE OR DELETE ON party_ledger
FOR EACH ROW EXECUTE FUNCTION party_ledger_reject_change();--> statement-breakpoint
CREATE TRIGGER party_ledger_no_truncate
BEFORE TRUNCATE ON party_ledger
FOR EACH STATEMENT EXECUTE FUNCTION party_ledger_reject_change();--> statement-breakpoint

-- 4. Audit log: GSTIN profiles, sales settings, document series, and every
-- status change of a tax document (issue, cancel) or its e-invoice details.
CREATE TRIGGER audit_gstin_profiles
AFTER INSERT OR UPDATE ON gstin_profiles
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'gstin', 'aato_band', 'einvoice_required_from', 'eway_threshold_paise');--> statement-breakpoint
CREATE TRIGGER audit_sales_settings
AFTER INSERT OR UPDATE ON sales_settings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'stock_post_on', 'walk_in_party_id', 'quote_validity_days', 'partial_min_advance_pct', 'default_price_mode', 'billing_live_on');--> statement-breakpoint
CREATE TRIGGER audit_document_series
AFTER INSERT OR UPDATE ON document_series
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'store_id', 'kind', 'prefix', 'digits', 'is_active');--> statement-breakpoint
CREATE TRIGGER audit_tax_documents
AFTER UPDATE ON tax_documents
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status', 'number', 'cancel_reason', 'irn', 'ack_no');
