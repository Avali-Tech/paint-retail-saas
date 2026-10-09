-- The GST nature of every line already issued, so a 0% exempt line prints as
-- exempt, not nil-rated. Issue decides it as gstRatesFor does: a positive rate is
-- taxable; 0% is exempt for the Exempt default category, nil-rated otherwise.
-- Lines without a rate (drafts, bills of supply) keep none.
--
-- Issued lines are never updated (tax_document_lines_draft_only, 0055), so that
-- one trigger is set aside for this backfill only, inside the migration's
-- transaction, and is back before anything else can write.
ALTER TABLE tax_document_lines DISABLE TRIGGER tax_document_lines_draft_only;--> statement-breakpoint
UPDATE tax_document_lines l
SET tax_nature = (CASE
  WHEN l.rate_bps > 0 THEN 'taxable'
  WHEN (SELECT c.key FROM tax_categories c WHERE c.id = l.tax_category_id) = 'exempt' THEN 'exempt'
  ELSE 'nil_rated'
END)::tax_nature
WHERE l.rate_bps IS NOT NULL;--> statement-breakpoint
ALTER TABLE tax_document_lines ENABLE TRIGGER tax_document_lines_draft_only;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_nature_with_rate" CHECK (("tax_document_lines"."tax_nature" is null) = ("tax_document_lines"."rate_bps" is null));

-- The reason of every allocation reversal already written: a bounce reverses its
-- cheque's allocations on the day it bounced (payments.bounce); anything else was
-- undone by hand. Allocations are append-only (allocations_append_only, 0058), so
-- that trigger is set aside for this backfill only, as above.
ALTER TABLE allocations DISABLE TRIGGER allocations_append_only;--> statement-breakpoint
UPDATE allocations r
SET reversal_reason = (CASE
  WHEN EXISTS (
    SELECT 1 FROM allocations o JOIN payments p ON p.id = o.payment_id
    WHERE o.id = r.reverses_allocation_id
      AND p.cheque_status = 'bounced'
      AND p.cheque_bounced_on = (r.created_at AT TIME ZONE 'Asia/Kolkata')::date
  ) THEN 'cheque_bounce'
  ELSE 'undone'
END)::allocation_reversal_reason
WHERE r.reverses_allocation_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE allocations ENABLE TRIGGER allocations_append_only;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_reversal_reason" CHECK (("allocations"."reversal_reason" is null) = ("allocations"."reverses_allocation_id" is null));
--> statement-breakpoint

-- The bank account, UPI ID and terms printed on invoices are audited like every
-- other sales setting (who, when, old and new values): swapping the account an
-- invoice asks customers to pay into is a classic fraud route. Stored in full, as
-- audit_log keeps every other value; only members who may read the audit log see it.
DROP TRIGGER audit_sales_settings ON sales_settings;--> statement-breakpoint
CREATE TRIGGER audit_sales_settings
AFTER INSERT OR UPDATE ON sales_settings
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'stock_post_on', 'walk_in_party_id', 'quote_validity_days', 'partial_min_advance_pct', 'default_price_mode', 'billing_live_on', 'cash_needs_register', 'register_variance_alert_paise', 'bank_name', 'bank_account_name', 'bank_account_number', 'bank_ifsc', 'upi_id', 'invoice_terms');
