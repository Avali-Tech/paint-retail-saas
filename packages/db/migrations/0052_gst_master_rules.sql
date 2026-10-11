-- GST master data (MVP 2, Sell & Bill): rules the tables of 0051 keep, the
-- default tax categories every business starts with, and backfills.

-- 1. Rate periods of one category never overlap. btree_gist ships with
-- PostgreSQL and is allowed on Amazon RDS.
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
ALTER TABLE tax_rates ADD CONSTRAINT tax_rates_no_overlap
  EXCLUDE USING gist (tax_category_id WITH =, daterange(effective_from, effective_to, '[]') WITH &&);--> statement-breakpoint

-- 2. A rate is history: tenants never delete or edit one. The only change allowed
-- is closing the open period when the next rate is added. Categories are
-- deactivated, not deleted.
REVOKE UPDATE, DELETE, TRUNCATE ON tax_rates FROM app_tenant;--> statement-breakpoint
GRANT UPDATE (effective_to) ON tax_rates TO app_tenant;--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON tax_categories FROM app_tenant;--> statement-breakpoint
CREATE FUNCTION tax_rates_close_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.effective_to IS NOT NULL
     OR NEW.rate_bps <> OLD.rate_bps
     OR NEW.effective_from <> OLD.effective_from
     OR NEW.tax_category_id <> OLD.tax_category_id
     OR NEW.organization_id <> OLD.organization_id THEN
    RAISE EXCEPTION 'a tax rate is never changed; add a new rate instead'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER tax_rates_close_only
BEFORE UPDATE ON tax_rates
FOR EACH ROW EXECUTE FUNCTION tax_rates_close_only();--> statement-breakpoint

-- 3. Owners and admins set the business's legal name (row-level security keeps it to theirs).
GRANT UPDATE (legal_name) ON organizations TO app_tenant;--> statement-breakpoint

-- 4. The tax categories every business starts with.
--
-- NEEDS CA CONFIRMATION before the first invoice. Rates checked against CBIC
-- Notification No. 9/2025-Central Tax (Rate) of 17 September 2025, in force from
-- 22 September 2025 (the GST rate rationalisation), Schedule II (CGST 9% + SGST 9%,
-- or IGST 18%): paints and varnishes, including enamels and lacquers (HSN 3208,
-- 3209, 3210); glaziers' putty, painters' fillings and wall putty (HSN 3214);
-- brushes, paint pads and rollers (HSN 9603); hand tools such as scrapers and
-- putty knives (HSN 8205). All stay at 18%. "Exempt" (0%) is for goods sold
-- without GST. A change in law is a new tax_rates row, never an edit.
CREATE FUNCTION seed_default_tax_categories(organization uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH defaults (key, name, rate_bps, is_default) AS (VALUES
    ('paints', 'Paints 18%', 1800, true),
    ('varnishes', 'Varnishes & wood finishes 18%', 1800, false),
    ('putty', 'Putty & fillers 18%', 1800, false),
    ('brushes_rollers', 'Brushes & rollers 18%', 1800, false),
    ('tools', 'Tools 18%', 1800, false),
    ('exempt', 'Exempt', 0, false)
  ),
  inserted AS (
    INSERT INTO tax_categories (organization_id, key, name, is_default)
    SELECT organization, key, name, is_default FROM defaults
    ON CONFLICT DO NOTHING
    RETURNING id, key
  )
  INSERT INTO tax_rates (organization_id, tax_category_id, rate_bps, effective_from)
  SELECT organization, inserted.id, defaults.rate_bps, DATE '2025-09-22'
  FROM inserted JOIN defaults USING (key);
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION seed_default_tax_categories(uuid) FROM PUBLIC;--> statement-breakpoint

-- Every new business gets them, whichever code path creates it (sign-up, the platform console).
CREATE FUNCTION organizations_seed_tax_categories() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM seed_default_tax_categories(NEW.id);
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION organizations_seed_tax_categories() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER organizations_tax_categories
AFTER INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION organizations_seed_tax_categories();--> statement-breakpoint

SELECT seed_default_tax_categories(id) FROM organizations;--> statement-breakpoint

-- 5. Backfill: each existing product gets the tax category matching its
-- catalogue category (or that category's parent) by name; failing that, its
-- product type; failing that, Paints 18%. A product keeps the rate it had: when
-- the match carries another rate it gets a category with its own rate instead
-- (Exempt for 0%, or a new "GST n%" category for a rate no default carries).
INSERT INTO tax_categories (organization_id, name)
SELECT DISTINCT p.organization_id, 'GST ' || trim_scale(p.gst_rate_bps / 100.0)::text || '%'
FROM products p
WHERE p.gst_rate_bps NOT IN (0, 1800)
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO tax_rates (organization_id, tax_category_id, rate_bps, effective_from)
SELECT DISTINCT tc.organization_id, tc.id, p.gst_rate_bps, DATE '2017-07-01'
FROM products p
JOIN tax_categories tc
  ON tc.organization_id = p.organization_id
 AND tc.key IS NULL
 AND tc.name = 'GST ' || trim_scale(p.gst_rate_bps / 100.0)::text || '%'
WHERE p.gst_rate_bps NOT IN (0, 1800)
  AND NOT EXISTS (SELECT 1 FROM tax_rates tr WHERE tr.tax_category_id = tc.id);--> statement-breakpoint
WITH named AS (
  SELECT p.id, p.type::text AS type,
         coalesce(c.name, '') || ' ' || coalesce(parent.name, '') AS names
  FROM products p
  LEFT JOIN categories c ON c.id = p.category_id
  LEFT JOIN categories parent ON parent.id = c.parent_id
  WHERE p.tax_category_id IS NULL
),
matched AS (
  SELECT named.id, CASE
    WHEN named.names ~* 'putty|filler' THEN 'putty'
    WHEN named.names ~* 'varnish|wood|polish|lacquer|stain' THEN 'varnishes'
    WHEN named.names ~* 'brush|roller' THEN 'brushes_rollers'
    WHEN named.names ~* 'tool|accessor' THEN 'tools'
    WHEN named.names ~* 'paint|emulsion|enamel|primer|distemper|texture|coating|waterproof' THEN 'paints'
    WHEN named.type = 'putty' THEN 'putty'
    WHEN named.type = 'wood_finish' THEN 'varnishes'
    WHEN named.type = 'tool' THEN 'tools'
    ELSE 'paints'
  END AS key
  FROM named
)
UPDATE products p
SET tax_category_id = (
  SELECT tc.id
  FROM tax_categories tc
  JOIN tax_rates tr ON tr.tax_category_id = tc.id AND tr.effective_to IS NULL
  WHERE tc.organization_id = p.organization_id AND tr.rate_bps = p.gst_rate_bps
  ORDER BY tc.key = matched.key DESC NULLS LAST, tc.is_default DESC, tc.name
  LIMIT 1
)
FROM matched
WHERE matched.id = p.id;--> statement-breakpoint

-- 6. A party's place of supply follows its GSTIN whenever it has one.
CREATE FUNCTION parties_place_of_supply_from_gstin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.gstin IS NOT NULL THEN
    NEW.place_of_supply := left(NEW.gstin, 2);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER parties_place_of_supply
BEFORE INSERT OR UPDATE OF gstin, place_of_supply ON parties
FOR EACH ROW EXECUTE FUNCTION parties_place_of_supply_from_gstin();--> statement-breakpoint
UPDATE parties SET place_of_supply = left(gstin, 2) WHERE gstin IS NOT NULL;--> statement-breakpoint

-- Parties without a GSTIN: from the state typed in their address, where it names
-- one (the names in GST_STATES of @paint/shared, plus a few older spellings).
UPDATE parties p
SET place_of_supply = names.code
FROM (VALUES
  ('01', 'jammu and kashmir'), ('01', 'jammu & kashmir'), ('02', 'himachal pradesh'),
  ('03', 'punjab'), ('04', 'chandigarh'), ('05', 'uttarakhand'), ('06', 'haryana'),
  ('07', 'delhi'), ('07', 'new delhi'), ('08', 'rajasthan'), ('09', 'uttar pradesh'),
  ('10', 'bihar'), ('11', 'sikkim'), ('12', 'arunachal pradesh'), ('13', 'nagaland'),
  ('14', 'manipur'), ('15', 'mizoram'), ('16', 'tripura'), ('17', 'meghalaya'),
  ('18', 'assam'), ('19', 'west bengal'), ('20', 'jharkhand'), ('21', 'odisha'),
  ('21', 'orissa'), ('22', 'chhattisgarh'), ('23', 'madhya pradesh'), ('24', 'gujarat'),
  ('26', 'dadra and nagar haveli and daman and diu'), ('27', 'maharashtra'),
  ('29', 'karnataka'), ('30', 'goa'), ('31', 'lakshadweep'), ('32', 'kerala'),
  ('33', 'tamil nadu'), ('34', 'puducherry'), ('34', 'pondicherry'),
  ('35', 'andaman and nicobar islands'), ('36', 'telangana'), ('37', 'andhra pradesh'),
  ('38', 'ladakh'), ('97', 'other territory')
) AS names (code, name)
WHERE p.gstin IS NULL AND p.place_of_supply IS NULL AND lower(trim(p.state)) = names.name;--> statement-breakpoint

-- 7. Stores that already had a GSTIN keep it, with its state code; the owner
-- confirms the registration (type and legal name) under Settings, Tax & GST.
UPDATE stores SET gst_state_code = left(gstin, 2) WHERE gstin ~ '^[0-9]{2}';--> statement-breakpoint

-- 8. Audit log: tax categories and rates, store registrations, the business's
-- legal name, and a product's HSN code and tax category.
-- New categories and rates are logged when someone adds them; the defaults a
-- business starts with (system work, no member) are not changes.
CREATE TRIGGER audit_tax_categories
AFTER UPDATE ON tax_categories
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'name', 'is_default', 'is_active');--> statement-breakpoint
CREATE TRIGGER audit_tax_categories_added
AFTER INSERT ON tax_categories
FOR EACH ROW WHEN (nullif(current_setting('app.current_member_id', true), '') IS NOT NULL)
EXECUTE FUNCTION audit_row_change('id', 'name', 'is_default', 'is_active');--> statement-breakpoint
CREATE TRIGGER audit_tax_rates
AFTER UPDATE ON tax_rates
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'tax_category_id', 'rate_bps', 'effective_from', 'effective_to');--> statement-breakpoint
CREATE TRIGGER audit_tax_rates_added
AFTER INSERT ON tax_rates
FOR EACH ROW WHEN (nullif(current_setting('app.current_member_id', true), '') IS NOT NULL)
EXECUTE FUNCTION audit_row_change('id', 'tax_category_id', 'rate_bps', 'effective_from', 'effective_to');--> statement-breakpoint
CREATE TRIGGER audit_store_gst_registrations
AFTER UPDATE ON stores
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'gst_registration_type', 'gst_state_code', 'gstin', 'legal_name', 'trade_name', 'address_line', 'city', 'pincode');--> statement-breakpoint
DROP TRIGGER audit_organization_plan ON organizations;--> statement-breakpoint
CREATE TRIGGER audit_organization_plan
AFTER UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'plan', 'feature_flags', 'suspended_at', 'suspend_reason', 'two_factor_required', 'slug', 'legal_name');--> statement-breakpoint
DROP TRIGGER audit_products ON products;--> statement-breakpoint
CREATE TRIGGER audit_products
AFTER UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'is_active', 'brand_id', 'category_id', 'hsn_code', 'tax_category_id');
