-- Tint records and estimates (MVP 2, Sell & Bill, round 5a; spec §3.3, §3.6,
-- §6.2, §6.3): rules the tables of 0063 keep.

-- 1. A tint record belongs to a line of a draft: it is added or removed only
-- while the line's quotation, sales order or invoice is a draft (so an issued
-- invoice's shade is history), it is never edited, and its base is always the
-- line's variant. An invoice line is one of an invoice or bill of supply,
-- never of a note. When a draft's lines are replaced or the draft is deleted,
-- the records go with the lines (the line is gone by the time they cascade).
REVOKE UPDATE, TRUNCATE ON tint_records FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION tint_records_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rec tint_records;
  parent_status text;
  parent_kind text;
  line_variant uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a tint record is never changed: delete it and tint again'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    rec := NEW;
  ELSE
    rec := OLD;
  END IF;
  IF rec.quotation_line_id IS NOT NULL THEN
    SELECT q.status::text, l.variant_id INTO parent_status, line_variant
    FROM quotation_lines l JOIN quotations q ON q.id = l.quotation_id
    WHERE l.id = rec.quotation_line_id
    FOR SHARE OF q;
  ELSIF rec.sales_order_line_id IS NOT NULL THEN
    SELECT o.status::text, l.variant_id INTO parent_status, line_variant
    FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id
    WHERE l.id = rec.sales_order_line_id
    FOR SHARE OF o;
  ELSE
    SELECT d.status::text, d.kind::text, l.variant_id INTO parent_status, parent_kind, line_variant
    FROM tax_document_lines l JOIN tax_documents d ON d.id = l.document_id
    WHERE l.id = rec.invoice_line_id
    FOR SHARE OF d;
  END IF;
  -- No line: being deleted (the record goes with it), or none to tint (the
  -- foreign key or tint_records_one_line refuses the insert).
  IF parent_status IS NULL THEN
    RETURN rec;
  END IF;
  IF parent_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'only a line of a draft is tinted or untinted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF parent_kind NOT IN ('invoice', 'bill_of_supply') THEN
      RAISE EXCEPTION 'only a line of an invoice or bill of supply is tinted'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.base_variant_id IS DISTINCT FROM line_variant THEN
      RAISE EXCEPTION 'a tint record''s base is its line''s variant'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN rec;
END
$$;--> statement-breakpoint
CREATE TRIGGER tint_records_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON tint_records
FOR EACH ROW EXECUTE FUNCTION tint_records_draft_only();--> statement-breakpoint

-- 2. An estimate changes only while a draft: once converted into a quotation
-- it is final and never deleted. Its surfaces and options (the estimator's
-- results too) change only while it is a draft.
CREATE FUNCTION estimates_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'a converted estimate cannot be changed or deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;--> statement-breakpoint
CREATE TRIGGER estimates_draft_only
BEFORE UPDATE OR DELETE ON estimates
FOR EACH ROW EXECUTE FUNCTION estimates_draft_only();--> statement-breakpoint
CREATE FUNCTION estimate_parts_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_status estimate_status;
BEGIN
  FOR parent_status IN
    SELECT e.status FROM estimates e
    WHERE e.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.estimate_id END,
                   CASE WHEN TG_OP <> 'DELETE' THEN NEW.estimate_id END)
    FOR SHARE
  LOOP
    IF parent_status <> 'draft' THEN
      RAISE EXCEPTION 'a converted estimate cannot be changed'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END LOOP;
  RETURN coalesce(NEW, OLD);
END
$$;--> statement-breakpoint
CREATE TRIGGER estimate_surfaces_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON estimate_surfaces
FOR EACH ROW EXECUTE FUNCTION estimate_parts_draft_only();--> statement-breakpoint
CREATE TRIGGER estimate_options_draft_only
BEFORE INSERT OR UPDATE OR DELETE ON estimate_options
FOR EACH ROW EXECUTE FUNCTION estimate_parts_draft_only();--> statement-breakpoint

-- 3. Audit log: every estimate and its conversion.
CREATE TRIGGER audit_estimates
AFTER INSERT OR UPDATE ON estimates
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'number', 'status', 'quotation_id', 'converted_tier');
