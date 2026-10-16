-- Brand statement reconciliation (MVP 3 round 6a, P2-M34; docs/mvp-3/credit-and-receivables.md
-- §3.9): rules the tables of 0088 keep.

-- 1. A template keeps its business, supplier and author; it is switched off, never deleted
-- (statements point to it).
REVOKE DELETE, TRUNCATE ON brand_statement_templates FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION brand_statement_templates_keep() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a statement template is never deleted: switch it off'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.supplier_party_id IS DISTINCT FROM OLD.supplier_party_id
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id THEN
    RAISE EXCEPTION 'a statement template keeps its business, supplier and author'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER brand_statement_templates_keep
BEFORE UPDATE OR DELETE ON brand_statement_templates
FOR EACH ROW EXECUTE FUNCTION brand_statement_templates_keep();--> statement-breakpoint

-- 2. An imported statement is fixed: only its status (active → discarded, once), when it
-- was last matched and who discarded it change. Tenants never delete one.
REVOKE DELETE, TRUNCATE ON brand_statements FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION brand_statements_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  moving text[] := ARRAY['status', 'matched_at', 'discarded_at', 'discarded_by_member_id',
    'updated_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a brand statement is never deleted: discard it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'an imported brand statement does not change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'discarded'
     AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'a discarded brand statement does not change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER brand_statements_fixed
BEFORE UPDATE OR DELETE ON brand_statements
FOR EACH ROW EXECUTE FUNCTION brand_statements_fixed();--> statement-breakpoint

-- 3. Lines are written once, with an active statement, and never changed or deleted. A
-- cascade from the statement being removed (a business deleted by the platform) finds no
-- statement and passes.
REVOKE UPDATE, DELETE, TRUNCATE ON brand_statement_lines FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION brand_statement_lines_fixed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  statement_status brand_statement_status;
BEGIN
  SELECT s.status INTO statement_status FROM brand_statements s
  WHERE s.organization_id = coalesce(NEW.organization_id, OLD.organization_id)
    AND s.id = coalesce(NEW.statement_id, OLD.statement_id);
  IF TG_OP = 'INSERT' THEN
    IF statement_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'lines are added only to an active statement'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND statement_status IS NULL THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'a statement line is never changed'
    USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER brand_statement_lines_fixed
BEFORE INSERT OR UPDATE OR DELETE ON brand_statement_lines
FOR EACH ROW EXECUTE FUNCTION brand_statement_lines_fixed();--> statement-breakpoint

-- 4. Matches are added and removed, never changed, and only on an active statement
-- (discarding removes them first). A GRN matched is one of the statement's supplier; a
-- receipt, one of a scheme of the statement's brand.
REVOKE UPDATE, TRUNCATE ON brand_statement_matches FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION brand_statement_matches_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  statement brand_statements%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a statement match is never changed: remove it and match again'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO statement FROM brand_statements s
  WHERE s.organization_id = coalesce(NEW.organization_id, OLD.organization_id)
    AND s.id = coalesce(NEW.statement_id, OLD.statement_id);
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF statement.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'lines of a discarded statement are not matched'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.goods_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM goods_receipts g
    WHERE g.organization_id = NEW.organization_id AND g.id = NEW.goods_receipt_id
      AND g.supplier_party_id = statement.supplier_party_id
  ) THEN
    RAISE EXCEPTION 'that goods receipt is not from the statement''s supplier'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.benefit_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM brand_benefit_receipts r
    JOIN brand_schemes s ON s.organization_id = r.organization_id AND s.id = r.scheme_id
    WHERE r.organization_id = NEW.organization_id AND r.id = NEW.benefit_receipt_id
      AND r.kind = 'money' AND s.brand_id = statement.brand_id
  ) THEN
    RAISE EXCEPTION 'that receipt is not scheme money of the statement''s brand'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER brand_statement_matches_rules
BEFORE INSERT OR UPDATE OR DELETE ON brand_statement_matches
FOR EACH ROW EXECUTE FUNCTION brand_statement_matches_rules();--> statement-breakpoint

-- 5. Audit log (roadmap P1-M20): statements settle what we owe brands and they owe us.
CREATE TRIGGER audit_brand_statement_templates
AFTER INSERT OR UPDATE ON brand_statement_templates
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'name', 'supplier_party_id', 'brand_id', 'amount_mode', 'sign_convention', 'date_format', 'date_window_days', 'amount_tolerance_paise', 'grn_amount_basis', 'is_active');--> statement-breakpoint
CREATE TRIGGER audit_brand_statements
AFTER INSERT OR UPDATE ON brand_statements
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'number', 'template_id', 'supplier_party_id', 'period_from', 'period_to', 'opening_balance_paise', 'closing_balance_paise', 'sha256', 'status');--> statement-breakpoint
CREATE TRIGGER audit_brand_statement_matches
AFTER INSERT OR DELETE ON brand_statement_matches
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'statement_id', 'line_id', 'source', 'goods_receipt_id', 'benefit_receipt_id', 'difference_paise', 'note');
