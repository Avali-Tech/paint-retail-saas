CREATE TYPE "public"."allocation_reversal_reason" AS ENUM('undone', 'cheque_bounce');--> statement-breakpoint
ALTER TYPE "public"."tally_ledger_purpose" ADD VALUE 'bounce_charges';--> statement-breakpoint
ALTER TABLE "allocations" ADD COLUMN "reversal_reason" "allocation_reversal_reason";--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "bank_account_name" text;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "bank_account_number" text;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "bank_ifsc" text;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "upi_id" text;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "invoice_terms" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD COLUMN "tax_nature" "tax_nature";--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_bank_complete" CHECK (num_nonnulls("sales_settings"."bank_name", "sales_settings"."bank_account_name", "sales_settings"."bank_account_number", "sales_settings"."bank_ifsc") in (0, 4));--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_upi_with_bank" CHECK ("sales_settings"."upi_id" is null or "sales_settings"."bank_name" is not null);--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_invoice_terms" CHECK (cardinality("sales_settings"."invoice_terms") <= 10);