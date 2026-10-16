-- Settings brand profitability reads (MVP 3 round 5, P2-M35): the business's cost of
-- money ([PO-5]) and what a loyalty point is worth. Both are audited with the other
-- settings of their tables. No data migration: the column defaults (12 % a year, ₹1 a
-- point) apply to every existing business.
DROP TRIGGER audit_sales_settings ON sales_settings;--> statement-breakpoint
CREATE TRIGGER audit_sales_settings
AFTER INSERT OR UPDATE ON sales_settings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'stock_post_on', 'walk_in_party_id', 'quote_validity_days', 'partial_min_advance_pct', 'default_price_mode', 'billing_live_on', 'cash_needs_register', 'register_variance_alert_paise', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id', 'invoice_terms', 'payment_link_validity_minutes', 'payment_link_cap_paise', 'payment_link_amount_basis', 'cost_of_money_bps');--> statement-breakpoint
DROP TRIGGER audit_loyalty_settings ON loyalty_settings;--> statement-breakpoint
CREATE TRIGGER audit_loyalty_settings
AFTER INSERT OR UPDATE ON loyalty_settings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'earn_points', 'earn_per_paise', 'tiers', 'expiry_days', 'min_redemption_points', 'point_value_paise');
