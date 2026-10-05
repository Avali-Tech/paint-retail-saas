-- Audit log (roadmap P1-M20): brands, categories, products and pack sizes being
-- renamed, moved, deactivated or reactivated. New records are not changes.
CREATE TRIGGER audit_brands
AFTER UPDATE ON brands
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'name', 'is_active');--> statement-breakpoint

CREATE TRIGGER audit_categories
AFTER UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'name', 'parent_id', 'is_active');--> statement-breakpoint

CREATE TRIGGER audit_products
AFTER UPDATE ON products
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'is_active', 'brand_id', 'category_id');--> statement-breakpoint

CREATE TRIGGER audit_product_variant_status
AFTER UPDATE ON product_variants
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'is_active');
