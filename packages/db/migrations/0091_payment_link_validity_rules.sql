-- Payment-link validity (MVP 3 round 6a; [PO-60], [PO-61]; spec §6.2 PL-19, PL-20).
-- The validity of links sent in messages is audited with the other link rules.
DROP TRIGGER audit_sales_settings ON sales_settings;--> statement-breakpoint
CREATE TRIGGER audit_sales_settings
AFTER INSERT OR UPDATE ON sales_settings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'stock_post_on', 'walk_in_party_id', 'quote_validity_days', 'partial_min_advance_pct', 'default_price_mode', 'billing_live_on', 'cash_needs_register', 'register_variance_alert_paise', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id', 'invoice_terms', 'payment_link_validity_minutes', 'payment_link_cap_paise', 'payment_link_amount_basis', 'cost_of_money_bps', 'message_link_validity_minutes');--> statement-breakpoint
-- Data: Razorpay refuses a link that expires sooner than 15 minutes ahead ([PO-60]), so a
-- business already connected to Razorpay with a shorter validity is raised to 15 minutes,
-- as connecting does from now on. Safe to re-run.
UPDATE sales_settings ss
SET payment_link_validity_minutes = greatest(ss.payment_link_validity_minutes, 15),
    message_link_validity_minutes = greatest(ss.message_link_validity_minutes, 15),
    updated_at = now()
WHERE (ss.payment_link_validity_minutes < 15 OR ss.message_link_validity_minutes < 15)
  AND EXISTS (
    SELECT 1 FROM payment_gateway_accounts a
    WHERE a.organization_id = ss.organization_id
      AND a.gateway = 'razorpay' AND a.credentials_sealed IS NOT NULL
  );
