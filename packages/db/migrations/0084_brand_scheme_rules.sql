-- Brand schemes (MVP 3 round 5a, P2-M33; docs/mvp-3/credit-and-receivables.md §3.8):
-- rules the tables of 0083 keep. The notification events 0083 added are not named here:
-- migrations run in one transaction, and a value added to an enum cannot be used in it.

-- 1. A scheme keeps its business, brand and author. Its status moves forward only:
-- draft → active or cancelled, active → closed or cancelled. A closed or cancelled
-- scheme never changes again. Tenants never delete one: they cancel it.
REVOKE DELETE, TRUNCATE ON brand_schemes FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION brand_schemes_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a brand scheme is never deleted: cancel it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id THEN
    RAISE EXCEPTION 'a brand scheme keeps its business, brand and author'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('closed', 'cancelled')
     AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'a % brand scheme does not change', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status IN ('active', 'cancelled'))
    OR (OLD.status = 'active' AND NEW.status IN ('closed', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'a % brand scheme cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER brand_schemes_forward_only
BEFORE UPDATE OR DELETE ON brand_schemes
FOR EACH ROW EXECUTE FUNCTION brand_schemes_forward_only();--> statement-breakpoint

-- 2. What a scheme covers, its slabs and their benefits change only while the scheme
-- is a draft or active (editing replaces them). A cascade from a scheme being removed
-- (a business deleted by the platform) finds no scheme and passes.
CREATE FUNCTION brand_scheme_parts_editable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  scheme_status brand_scheme_status;
BEGIN
  SELECT s.status INTO scheme_status FROM brand_schemes s
  WHERE s.organization_id = coalesce(NEW.organization_id, OLD.organization_id)
    AND s.id = coalesce(NEW.scheme_id, OLD.scheme_id);
  IF scheme_status IN ('closed', 'cancelled') THEN
    RAISE EXCEPTION 'a % brand scheme does not change', scheme_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.scheme_id IS DISTINCT FROM OLD.scheme_id THEN
    RAISE EXCEPTION 'a scheme''s part stays with its scheme'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN coalesce(NEW, OLD);
END
$$;--> statement-breakpoint
CREATE TRIGGER brand_scheme_items_editable
BEFORE INSERT OR UPDATE OR DELETE ON brand_scheme_items
FOR EACH ROW EXECUTE FUNCTION brand_scheme_parts_editable();--> statement-breakpoint
CREATE TRIGGER brand_scheme_slabs_editable
BEFORE INSERT OR UPDATE OR DELETE ON brand_scheme_slabs
FOR EACH ROW EXECUTE FUNCTION brand_scheme_parts_editable();--> statement-breakpoint
CREATE TRIGGER brand_scheme_benefits_editable
BEFORE INSERT OR UPDATE OR DELETE ON brand_scheme_benefits
FOR EACH ROW EXECUTE FUNCTION brand_scheme_parts_editable();--> statement-breakpoint

-- 3. Received benefits are append-only (a mistake is reversed by a negative entry) and
-- are recorded only on an active or closed scheme (a late credit note still counts).
REVOKE UPDATE, DELETE, TRUNCATE ON brand_benefit_receipts FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION brand_benefit_receipts_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  scheme_status brand_scheme_status;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'a received benefit is never changed: record a reversal'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT s.status INTO scheme_status FROM brand_schemes s
  WHERE s.organization_id = NEW.organization_id AND s.id = NEW.scheme_id;
  IF scheme_status NOT IN ('active', 'closed') THEN
    RAISE EXCEPTION 'benefits are recorded only on an active or closed scheme, not a % one', scheme_status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER brand_benefit_receipts_append_only
BEFORE INSERT OR UPDATE OR DELETE ON brand_benefit_receipts
FOR EACH ROW EXECUTE FUNCTION brand_benefit_receipts_append_only();--> statement-breakpoint

-- 4. A claim keeps its scheme, number, date, amount and author; its status moves forward
-- only: filed → acknowledged, settled, rejected or withdrawn; acknowledged → settled,
-- rejected or withdrawn. A resolved claim is closed. Filed only on an active or closed
-- scheme. Tenants never delete one.
REVOKE DELETE, TRUNCATE ON brand_claims FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION brand_claims_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  moving text[] := ARRAY['status', 'brand_reference', 'note', 'resolved_at',
    'resolved_by_member_id', 'resolution_note', 'updated_at'];
  scheme_status brand_scheme_status;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a brand claim is never deleted: withdraw it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT s.status INTO scheme_status FROM brand_schemes s
    WHERE s.organization_id = NEW.organization_id AND s.id = NEW.scheme_id;
    IF scheme_status NOT IN ('active', 'closed') THEN
      RAISE EXCEPTION 'claims are filed only on an active or closed scheme, not a % one', scheme_status
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - moving) IS DISTINCT FROM (to_jsonb(OLD) - moving) THEN
    RAISE EXCEPTION 'a brand claim keeps its scheme, number, date and amount'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status IN ('settled', 'rejected', 'withdrawn')
     AND to_jsonb(NEW) - 'updated_at' IS DISTINCT FROM to_jsonb(OLD) - 'updated_at' THEN
    RAISE EXCEPTION 'a % brand claim is closed', OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'filed' AND NEW.status IN ('acknowledged', 'settled', 'rejected', 'withdrawn'))
    OR (OLD.status = 'acknowledged' AND NEW.status IN ('settled', 'rejected', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'a % brand claim cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER brand_claims_forward_only
BEFORE INSERT OR UPDATE OR DELETE ON brand_claims
FOR EACH ROW EXECUTE FUNCTION brand_claims_forward_only();--> statement-breakpoint

-- 5. Audit log (roadmap P1-M20): schemes decide money the brand owes us.
CREATE TRIGGER audit_brand_schemes
AFTER INSERT OR UPDATE ON brand_schemes
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'brand_id', 'name', 'starts_on', 'ends_on', 'measure', 'mode', 'settlement_days', 'date_basis', 'status', 'end_note');--> statement-breakpoint
CREATE TRIGGER audit_brand_scheme_items
AFTER INSERT OR DELETE ON brand_scheme_items
FOR EACH ROW EXECUTE FUNCTION audit_row_change('scheme_id', 'product_id', 'category_id');--> statement-breakpoint
CREATE TRIGGER audit_brand_scheme_slabs
AFTER INSERT OR DELETE ON brand_scheme_slabs
FOR EACH ROW EXECUTE FUNCTION audit_row_change('scheme_id', 'position', 'target');--> statement-breakpoint
CREATE TRIGGER audit_brand_scheme_benefits
AFTER INSERT OR DELETE ON brand_scheme_benefits
FOR EACH ROW EXECUTE FUNCTION audit_row_change('scheme_id', 'slab_id', 'kind', 'basis_points', 'paise_per_litre', 'variant_id', 'units', 'per_millilitres', 'label', 'points');--> statement-breakpoint
CREATE TRIGGER audit_brand_benefit_receipts
AFTER INSERT ON brand_benefit_receipts
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'scheme_id', 'claim_id', 'kind', 'received_on', 'amount_paise', 'money_form', 'variant_id', 'units', 'label', 'points', 'reference');--> statement-breakpoint
CREATE TRIGGER audit_brand_claims
AFTER INSERT OR UPDATE ON brand_claims
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'scheme_id', 'number', 'claimed_paise', 'status', 'brand_reference');
