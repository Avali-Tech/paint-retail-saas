CREATE TYPE "public"."aato_band" AS ENUM('up_to_5cr', 'above_5cr');--> statement-breakpoint
CREATE TYPE "public"."gst_class" AS ENUM('b2b', 'b2cl', 'b2cs');--> statement-breakpoint
CREATE TYPE "public"."itc_reversal_status" AS ENUM('unknown', 'reversed', 'not_reversed');--> statement-breakpoint
CREATE TYPE "public"."party_ledger_entry_type" AS ENUM('opening', 'invoice', 'debit_note', 'credit_note', 'payment_in', 'refund_out', 'cheque_bounce', 'adjustment', 'cancellation');--> statement-breakpoint
CREATE TYPE "public"."price_mode" AS ENUM('inclusive', 'exclusive');--> statement-breakpoint
CREATE TYPE "public"."return_disposition" AS ENUM('restock', 'damage');--> statement-breakpoint
CREATE TYPE "public"."sales_return_status" AS ENUM('draft', 'completed');--> statement-breakpoint
CREATE TYPE "public"."stock_post_on" AS ENUM('invoice', 'dispatch');--> statement-breakpoint
CREATE TYPE "public"."stock_posting" AS ENUM('on_issue', 'on_dispatch', 'none');--> statement-breakpoint
CREATE TYPE "public"."supply_type" AS ENUM('intra_state', 'inter_state');--> statement-breakpoint
CREATE TYPE "public"."tax_document_kind" AS ENUM('invoice', 'bill_of_supply', 'credit_note', 'debit_note', 'receipt_voucher', 'refund_voucher');--> statement-breakpoint
CREATE TYPE "public"."tax_document_link_kind" AS ENUM('note_of', 'advance_adjusted_in', 'replaces');--> statement-breakpoint
CREATE TYPE "public"."tax_document_status" AS ENUM('draft', 'issued', 'cancelled');--> statement-breakpoint
CREATE TABLE "document_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"kind" "tax_document_kind" NOT NULL,
	"prefix" text NOT NULL,
	"digits" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_series_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "document_series_prefix_format" CHECK ("document_series"."prefix" ~ '^[A-Z0-9]+$'),
	CONSTRAINT "document_series_length" CHECK ("document_series"."digits" >= 1 and char_length("document_series"."prefix") + 7 + "document_series"."digits" <= 16)
);
--> statement-breakpoint
ALTER TABLE "document_series" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gstin_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"gstin" text NOT NULL,
	"aato_band" "aato_band" DEFAULT 'up_to_5cr' NOT NULL,
	"einvoice_required_from" date,
	"eway_threshold_paise" bigint DEFAULT 5000000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gstin_profiles_organization_gstin_unique" UNIQUE("organization_id","gstin"),
	CONSTRAINT "gstin_profiles_gstin_format" CHECK ("gstin_profiles"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "gstin_profiles_eway_threshold_positive" CHECK ("gstin_profiles"."eway_threshold_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "gstin_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_member_key_unique" UNIQUE("organization_id","member_id","key"),
	CONSTRAINT "idempotency_keys_key_length" CHECK (char_length("idempotency_keys"."key") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party_balances" (
	"organization_id" uuid NOT NULL,
	"party_id" uuid PRIMARY KEY NOT NULL,
	"balance_paise" bigint DEFAULT 0 NOT NULL,
	"advance_paise" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "party_balances_advance_not_negative" CHECK ("party_balances"."advance_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "party_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"store_id" uuid,
	"entry_on" date NOT NULL,
	"entry_type" "party_ledger_entry_type" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reference_type" text,
	"reference_id" uuid,
	"note" text,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "party_ledger_amount_sign" CHECK (case
        when "party_ledger"."entry_type" in ('invoice', 'debit_note', 'refund_out', 'cheque_bounce') then "party_ledger"."amount_paise" > 0
        when "party_ledger"."entry_type" in ('credit_note', 'payment_in', 'cancellation') then "party_ledger"."amount_paise" < 0
        else "party_ledger"."amount_paise" <> 0
      end),
	CONSTRAINT "party_ledger_reference_pair" CHECK (("party_ledger"."reference_type" is null) = ("party_ledger"."reference_id" is null))
);
--> statement-breakpoint
ALTER TABLE "party_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"disposition" "return_disposition" NOT NULL,
	"reason" text,
	CONSTRAINT "sales_return_lines_return_line_unique" UNIQUE("return_id","invoice_line_id","disposition"),
	CONSTRAINT "sales_return_lines_quantity_positive" CHECK ("sales_return_lines"."quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "sales_return_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales_returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text,
	"invoice_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "sales_return_status" DEFAULT 'draft' NOT NULL,
	"credit_note_id" uuid,
	"note" text,
	"created_by_member_id" uuid NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_returns_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "sales_returns_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "sales_returns_completed" CHECK (("sales_returns"."status" = 'completed') = ("sales_returns"."completed_at" is not null)
        and ("sales_returns"."status" = 'completed') = ("sales_returns"."credit_note_id" is not null)
        and ("sales_returns"."status" = 'completed') = ("sales_returns"."number" is not null))
);
--> statement-breakpoint
ALTER TABLE "sales_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"stock_post_on" "stock_post_on" DEFAULT 'invoice' NOT NULL,
	"walk_in_party_id" uuid,
	"quote_validity_days" integer DEFAULT 15 NOT NULL,
	"partial_min_advance_pct" integer DEFAULT 0 NOT NULL,
	"default_price_mode" "price_mode" DEFAULT 'inclusive' NOT NULL,
	"billing_live_on" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_settings_quote_validity" CHECK ("sales_settings"."quote_validity_days" between 1 and 365),
	CONSTRAINT "sales_settings_advance_pct" CHECK ("sales_settings"."partial_min_advance_pct" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "sales_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"description" text,
	"hsn_code" text,
	"uqc" text,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"discount_bps" integer,
	"discount_paise" bigint,
	"gross_paise" bigint DEFAULT 0 NOT NULL,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"tax_category_id" uuid,
	"rate_bps" integer,
	"cess_bps" integer,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"source_line_id" uuid,
	CONSTRAINT "tax_document_lines_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tax_document_lines_document_line_unique" UNIQUE("document_id","line_no"),
	CONSTRAINT "tax_document_lines_line_no_positive" CHECK ("tax_document_lines"."line_no" > 0),
	CONSTRAINT "tax_document_lines_quantity_positive" CHECK ("tax_document_lines"."quantity" > 0),
	CONSTRAINT "tax_document_lines_amounts" CHECK ("tax_document_lines"."unit_price_paise" >= 0 and "tax_document_lines"."gross_paise" >= 0 and "tax_document_lines"."taxable_paise" >= 0
        and "tax_document_lines"."cgst_paise" >= 0 and "tax_document_lines"."sgst_paise" >= 0 and "tax_document_lines"."igst_paise" >= 0 and "tax_document_lines"."cess_paise" >= 0
        and "tax_document_lines"."total_paise" = "tax_document_lines"."taxable_paise" + "tax_document_lines"."cgst_paise" + "tax_document_lines"."sgst_paise" + "tax_document_lines"."igst_paise" + "tax_document_lines"."cess_paise"),
	CONSTRAINT "tax_document_lines_one_discount" CHECK (("tax_document_lines"."discount_bps" is null or "tax_document_lines"."discount_paise" is null)
        and "tax_document_lines"."discount_bps" between 0 and 10000 and "tax_document_lines"."discount_paise" >= 0),
	CONSTRAINT "tax_document_lines_rate_range" CHECK ("tax_document_lines"."rate_bps" between 0 and 10000),
	CONSTRAINT "tax_document_lines_hsn_format" CHECK ("tax_document_lines"."hsn_code" ~ '^[0-9]{4}([0-9]{2}){0,2}$')
);
--> statement-breakpoint
ALTER TABLE "tax_document_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax_document_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_document_id" uuid NOT NULL,
	"to_document_id" uuid NOT NULL,
	"kind" "tax_document_link_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_document_links_unique" UNIQUE("from_document_id","to_document_id","kind"),
	CONSTRAINT "tax_document_links_not_self" CHECK ("tax_document_links"."from_document_id" <> "tax_document_links"."to_document_id")
);
--> statement-breakpoint
ALTER TABLE "tax_document_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax_document_tax_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"hsn_code" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"cess_bps" integer DEFAULT 0 NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	CONSTRAINT "tax_document_tax_rows_unique" UNIQUE("document_id","hsn_code","rate_bps","cess_bps"),
	CONSTRAINT "tax_document_tax_rows_amounts" CHECK ("tax_document_tax_rows"."taxable_paise" >= 0 and "tax_document_tax_rows"."cgst_paise" >= 0 and "tax_document_tax_rows"."sgst_paise" >= 0 and "tax_document_tax_rows"."igst_paise" >= 0 and "tax_document_tax_rows"."cess_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tax_document_tax_rows" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "tax_document_kind" NOT NULL,
	"status" "tax_document_status" DEFAULT 'draft' NOT NULL,
	"store_id" uuid NOT NULL,
	"series_id" uuid,
	"number" text,
	"fy" text,
	"issued_on" date,
	"issued_at" timestamp with time zone,
	"supplier_gstin" text,
	"supplier_state_code" text,
	"supplier_legal_name" text,
	"supplier_trade_name" text,
	"supplier_address" text,
	"party_id" uuid,
	"buyer_name" text,
	"buyer_gstin" text,
	"buyer_address" text,
	"buyer_state_code" text,
	"ship_to_name" text,
	"ship_to_address" text,
	"ship_to_state_code" text,
	"place_of_supply_code" text,
	"supply_type" "supply_type",
	"gst_class" "gst_class",
	"price_mode" "price_mode" DEFAULT 'inclusive' NOT NULL,
	"reverse_charge" boolean DEFAULT false NOT NULL,
	"bill_discount_bps" integer,
	"bill_discount_paise" bigint,
	"taxable_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"cess_paise" bigint DEFAULT 0 NOT NULL,
	"round_off_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"due_on" date,
	"project_id" uuid,
	"influencer_party_id" uuid,
	"reason" text,
	"note" text,
	"stock_posting" "stock_posting" DEFAULT 'on_issue' NOT NULL,
	"itc_reversal_status" "itc_reversal_status",
	"irn" text,
	"ack_no" text,
	"ack_at" timestamp with time zone,
	"signed_qr" text,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_member_id" uuid,
	"created_by_member_id" uuid NOT NULL,
	"issued_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_documents_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tax_documents_number_unique" UNIQUE("organization_id","supplier_gstin","fy","kind","number"),
	CONSTRAINT "tax_documents_issued_complete" CHECK (("tax_documents"."status" = 'draft') = ("tax_documents"."number" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."fy" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."issued_on" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."issued_at" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."series_id" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."supplier_gstin" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."issued_by_member_id" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."supply_type" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."place_of_supply_code" is null)
        and ("tax_documents"."status" = 'draft') = ("tax_documents"."gst_class" is null)),
	CONSTRAINT "tax_documents_number_format" CHECK ("tax_documents"."number" ~ '^[A-Z0-9/-]{1,16}$' and "tax_documents"."fy" ~ '^[0-9]{4}-[0-9]{2}$'),
	CONSTRAINT "tax_documents_cancelled" CHECK (("tax_documents"."status" = 'cancelled') = ("tax_documents"."cancelled_at" is not null)
        and ("tax_documents"."cancelled_at" is null) = ("tax_documents"."cancel_reason" is null)
        and ("tax_documents"."cancelled_at" is null) = ("tax_documents"."cancelled_by_member_id" is null)),
	CONSTRAINT "tax_documents_total" CHECK ("tax_documents"."total_paise" = "tax_documents"."taxable_paise" + "tax_documents"."cgst_paise" + "tax_documents"."sgst_paise" + "tax_documents"."igst_paise" + "tax_documents"."cess_paise" + "tax_documents"."round_off_paise"),
	CONSTRAINT "tax_documents_amounts_not_negative" CHECK ("tax_documents"."taxable_paise" >= 0 and "tax_documents"."cgst_paise" >= 0 and "tax_documents"."sgst_paise" >= 0 and "tax_documents"."igst_paise" >= 0 and "tax_documents"."cess_paise" >= 0 and "tax_documents"."total_paise" >= 0),
	CONSTRAINT "tax_documents_round_off" CHECK ("tax_documents"."round_off_paise" between -50 and 50),
	CONSTRAINT "tax_documents_tax_by_supply" CHECK (case "tax_documents"."supply_type"
        when 'intra_state' then "tax_documents"."igst_paise" = 0 and "tax_documents"."cgst_paise" = "tax_documents"."sgst_paise"
        when 'inter_state' then "tax_documents"."cgst_paise" = 0 and "tax_documents"."sgst_paise" = 0
        else true end),
	CONSTRAINT "tax_documents_bill_of_supply_untaxed" CHECK ("tax_documents"."kind" <> 'bill_of_supply' or "tax_documents"."cgst_paise" + "tax_documents"."sgst_paise" + "tax_documents"."igst_paise" + "tax_documents"."cess_paise" = 0),
	CONSTRAINT "tax_documents_one_bill_discount" CHECK ("tax_documents"."bill_discount_bps" is null or "tax_documents"."bill_discount_paise" is null),
	CONSTRAINT "tax_documents_bill_discount_range" CHECK ("tax_documents"."bill_discount_bps" between 0 and 10000 and "tax_documents"."bill_discount_paise" >= 0),
	CONSTRAINT "tax_documents_no_reverse_charge" CHECK (not "tax_documents"."reverse_charge"),
	CONSTRAINT "tax_documents_state_codes" CHECK ("tax_documents"."buyer_state_code" ~ '^[0-9]{2}$' and "tax_documents"."ship_to_state_code" ~ '^[0-9]{2}$' and "tax_documents"."place_of_supply_code" ~ '^[0-9]{2}$' and "tax_documents"."supplier_state_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "tax_documents_buyer_gstin_format" CHECK ("tax_documents"."buyer_gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "tax_documents_irn_with_ack" CHECK ("tax_documents"."irn" is null or "tax_documents"."ack_no" is not null)
);
--> statement-breakpoint
ALTER TABLE "tax_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_series" ADD CONSTRAINT "document_series_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gstin_profiles" ADD CONSTRAINT "gstin_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_balances" ADD CONSTRAINT "party_balances_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_ledger" ADD CONSTRAINT "party_ledger_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_ledger" ADD CONSTRAINT "party_ledger_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_ledger" ADD CONSTRAINT "party_ledger_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_return_fk" FOREIGN KEY ("organization_id","return_id") REFERENCES "public"."sales_returns"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_invoice_line_fk" FOREIGN KEY ("organization_id","invoice_line_id") REFERENCES "public"."tax_document_lines"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_credit_note_fk" FOREIGN KEY ("organization_id","credit_note_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_walk_in_party_fk" FOREIGN KEY ("organization_id","walk_in_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_tax_category_fk" FOREIGN KEY ("organization_id","tax_category_id") REFERENCES "public"."tax_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_source_line_fk" FOREIGN KEY ("organization_id","source_line_id") REFERENCES "public"."tax_document_lines"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document_links" ADD CONSTRAINT "tax_document_links_from_fk" FOREIGN KEY ("organization_id","from_document_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document_links" ADD CONSTRAINT "tax_document_links_to_fk" FOREIGN KEY ("organization_id","to_document_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document_tax_rows" ADD CONSTRAINT "tax_document_tax_rows_document_fk" FOREIGN KEY ("organization_id","document_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_series_fk" FOREIGN KEY ("organization_id","series_id") REFERENCES "public"."document_series"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_influencer_fk" FOREIGN KEY ("organization_id","influencer_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_issued_by_fk" FOREIGN KEY ("organization_id","issued_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_cancelled_by_fk" FOREIGN KEY ("organization_id","cancelled_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_series_one_active" ON "document_series" USING btree ("store_id","kind") WHERE "document_series"."is_active";--> statement-breakpoint
CREATE INDEX "idempotency_keys_created_idx" ON "idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "party_balances_organization_idx" ON "party_balances" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "party_ledger_party_idx" ON "party_ledger" USING btree ("organization_id","party_id","entry_on","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "party_ledger_reference_unique" ON "party_ledger" USING btree ("reference_type","reference_id","entry_type") WHERE "party_ledger"."reference_id" is not null;--> statement-breakpoint
CREATE INDEX "sales_return_lines_invoice_line_idx" ON "sales_return_lines" USING btree ("organization_id","invoice_line_id");--> statement-breakpoint
CREATE INDEX "sales_returns_invoice_idx" ON "sales_returns" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE INDEX "tax_document_lines_variant_idx" ON "tax_document_lines" USING btree ("organization_id","variant_id");--> statement-breakpoint
CREATE INDEX "tax_document_links_to_idx" ON "tax_document_links" USING btree ("organization_id","to_document_id");--> statement-breakpoint
CREATE INDEX "tax_documents_store_issued_idx" ON "tax_documents" USING btree ("organization_id","store_id","issued_on" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "tax_documents_party_idx" ON "tax_documents" USING btree ("organization_id","party_id");--> statement-breakpoint
CREATE INDEX "tax_documents_organization_created_idx" ON "tax_documents" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE POLICY "document_series_tenant_isolation" ON "document_series" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("document_series"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("document_series"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "gstin_profiles_tenant_isolation" ON "gstin_profiles" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("gstin_profiles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("gstin_profiles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "idempotency_keys_tenant_isolation" ON "idempotency_keys" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("idempotency_keys"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("idempotency_keys"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_balances_tenant_isolation" ON "party_balances" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("party_balances"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("party_balances"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_ledger_tenant_isolation" ON "party_ledger" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("party_ledger"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("party_ledger"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sales_return_lines_tenant_isolation" ON "sales_return_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("sales_return_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("sales_return_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sales_returns_tenant_isolation" ON "sales_returns" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("sales_returns"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("sales_returns"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sales_settings_tenant_isolation" ON "sales_settings" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("sales_settings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("sales_settings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_document_lines_tenant_isolation" ON "tax_document_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("tax_document_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("tax_document_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_document_links_tenant_isolation" ON "tax_document_links" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("tax_document_links"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("tax_document_links"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_document_tax_rows_tenant_isolation" ON "tax_document_tax_rows" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("tax_document_tax_rows"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("tax_document_tax_rows"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_documents_tenant_isolation" ON "tax_documents" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("tax_documents"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("tax_documents"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);