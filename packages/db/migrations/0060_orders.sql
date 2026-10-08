CREATE TYPE "public"."payment_terms" AS ENUM('prepaid', 'partial', 'postpaid');--> statement-breakpoint
CREATE TYPE "public"."quotation_status" AS ENUM('draft', 'sent', 'accepted', 'expired', 'superseded', 'converted');--> statement-breakpoint
CREATE TYPE "public"."sales_order_status" AS ENUM('draft', 'confirmed', 'partly_fulfilled', 'fulfilled', 'cancelled', 'closed');--> statement-breakpoint
CREATE TYPE "public"."stock_reservation_status" AS ENUM('open', 'consumed', 'released');--> statement-breakpoint
CREATE TABLE "dispatch_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"value_paise" bigint NOT NULL,
	CONSTRAINT "dispatch_lines_dispatch_line_unique" UNIQUE("dispatch_id","invoice_line_id"),
	CONSTRAINT "dispatch_lines_quantity_positive" CHECK ("dispatch_lines"."quantity" > 0),
	CONSTRAINT "dispatch_lines_value_not_negative" CHECK ("dispatch_lines"."value_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "dispatch_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"dispatched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vehicle_no" text,
	"eway_bill_no" text,
	"eway_valid_until" date,
	"value_paise" bigint NOT NULL,
	"stock_posted" boolean NOT NULL,
	"note" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispatches_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "dispatches_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "dispatches_number_format" CHECK ("dispatches"."number" ~ '^DS-[0-9]{6,}$'),
	CONSTRAINT "dispatches_value_not_negative" CHECK ("dispatches"."value_paise" >= 0),
	CONSTRAINT "dispatches_eway_bill_no" CHECK ("dispatches"."eway_bill_no" ~ '^[0-9]{12}$'),
	CONSTRAINT "dispatches_eway_valid_with_number" CHECK ("dispatches"."eway_valid_until" is null or "dispatches"."eway_bill_no" is not null),
	CONSTRAINT "dispatches_text_lengths" CHECK (char_length("dispatches"."vehicle_no") <= 20 and char_length("dispatches"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "dispatches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quotation_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"description" text NOT NULL,
	"hsn_code" text,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"discount_bps" integer,
	"discount_paise" bigint,
	"tax_category_id" uuid,
	"rate_bps" integer,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"quotation_id" uuid NOT NULL,
	CONSTRAINT "quotation_lines_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "quotation_lines_quotation_line_unique" UNIQUE("quotation_id","line_no"),
	CONSTRAINT "quotation_lines_line_no_positive" CHECK ("quotation_lines"."line_no" > 0),
	CONSTRAINT "quotation_lines_quantity_positive" CHECK ("quotation_lines"."quantity" > 0),
	CONSTRAINT "quotation_lines_amounts" CHECK ("quotation_lines"."unit_price_paise" >= 0 and "quotation_lines"."taxable_paise" >= 0
        and "quotation_lines"."cgst_paise" >= 0 and "quotation_lines"."sgst_paise" >= 0 and "quotation_lines"."igst_paise" >= 0 and "quotation_lines"."cess_paise" >= 0
        and "quotation_lines"."total_paise" = "quotation_lines"."taxable_paise" + "quotation_lines"."cgst_paise" + "quotation_lines"."sgst_paise" + "quotation_lines"."igst_paise" + "quotation_lines"."cess_paise"),
	CONSTRAINT "quotation_lines_one_discount" CHECK (("quotation_lines"."discount_bps" is null or "quotation_lines"."discount_paise" is null)
        and "quotation_lines"."discount_bps" between 0 and 10000 and "quotation_lines"."discount_paise" >= 0),
	CONSTRAINT "quotation_lines_rate_range" CHECK ("quotation_lines"."rate_bps" between 0 and 10000),
	CONSTRAINT "quotation_lines_hsn_format" CHECK ("quotation_lines"."hsn_code" ~ '^[0-9]{4}([0-9]{2}){0,2}$')
);
--> statement-breakpoint
ALTER TABLE "quotation_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "quotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"root_quotation_id" uuid,
	"status" "quotation_status" DEFAULT 'draft' NOT NULL,
	"valid_until" date NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"sales_order_id" uuid,
	"store_id" uuid NOT NULL,
	"bill_to_party_id" uuid NOT NULL,
	"influencer_party_id" uuid,
	"project_id" uuid,
	"ship_to_name" text,
	"ship_to_address" text,
	"ship_to_state_code" text,
	"price_mode" "price_mode" NOT NULL,
	"bill_discount_bps" integer,
	"bill_discount_paise" bigint,
	"priced_on" date NOT NULL,
	"place_of_supply_code" text NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	"round_off_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"note" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "quotations_number_version_unique" UNIQUE("organization_id","number","version"),
	CONSTRAINT "quotations_number_format" CHECK ("quotations"."number" ~ '^QT-[0-9]{6,}$'),
	CONSTRAINT "quotations_version_root" CHECK ("quotations"."version" >= 1 and ("quotations"."version" = 1) = ("quotations"."root_quotation_id" is null)),
	CONSTRAINT "quotations_sent" CHECK (("quotations"."status" in ('sent', 'accepted', 'converted')) <= ("quotations"."sent_at" is not null)
        and ("quotations"."status" = 'accepted') <= ("quotations"."accepted_at" is not null)
        and ("quotations"."status" = 'converted') = ("quotations"."sales_order_id" is not null)),
	CONSTRAINT "quotations_state_codes" CHECK ("quotations"."ship_to_state_code" ~ '^[0-9]{2}$' and "quotations"."place_of_supply_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "quotations_bill_discount" CHECK (("quotations"."bill_discount_bps" is null or "quotations"."bill_discount_paise" is null)
        and "quotations"."bill_discount_bps" between 0 and 10000 and "quotations"."bill_discount_paise" >= 0),
	CONSTRAINT "quotations_amounts" CHECK ("quotations"."taxable_paise" >= 0 and "quotations"."cgst_paise" >= 0 and "quotations"."sgst_paise" >= 0
        and "quotations"."igst_paise" >= 0 and "quotations"."cess_paise" >= 0 and "quotations"."total_paise" >= 0
        and "quotations"."round_off_paise" between -50 and 50
        and "quotations"."total_paise" = "quotations"."taxable_paise" + "quotations"."cgst_paise" + "quotations"."sgst_paise" + "quotations"."igst_paise" + "quotations"."cess_paise" + "quotations"."round_off_paise"),
	CONSTRAINT "quotations_tax_by_supply" CHECK (case "quotations"."supply_type"
        when 'intra_state' then "quotations"."igst_paise" = 0 and "quotations"."cgst_paise" = "quotations"."sgst_paise"
        else "quotations"."cgst_paise" = 0 and "quotations"."sgst_paise" = 0 end),
	CONSTRAINT "quotations_note_length" CHECK (char_length("quotations"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "quotations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	"description" text NOT NULL,
	"hsn_code" text,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"discount_bps" integer,
	"discount_paise" bigint,
	"tax_category_id" uuid,
	"rate_bps" integer,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"order_id" uuid NOT NULL,
	"fulfil_store_id" uuid NOT NULL,
	"quantity_invoiced" numeric(14, 3) DEFAULT 0 NOT NULL,
	"quantity_cancelled" numeric(14, 3) DEFAULT 0 NOT NULL,
	CONSTRAINT "sales_order_lines_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "sales_order_lines_order_line_unique" UNIQUE("order_id","line_no"),
	CONSTRAINT "sales_order_lines_fulfilment" CHECK ("sales_order_lines"."quantity_invoiced" >= 0 and "sales_order_lines"."quantity_cancelled" >= 0
        and "sales_order_lines"."quantity_invoiced" + "sales_order_lines"."quantity_cancelled" <= "sales_order_lines"."quantity"),
	CONSTRAINT "sales_order_lines_line_no_positive" CHECK ("sales_order_lines"."line_no" > 0),
	CONSTRAINT "sales_order_lines_quantity_positive" CHECK ("sales_order_lines"."quantity" > 0),
	CONSTRAINT "sales_order_lines_amounts" CHECK ("sales_order_lines"."unit_price_paise" >= 0 and "sales_order_lines"."taxable_paise" >= 0
        and "sales_order_lines"."cgst_paise" >= 0 and "sales_order_lines"."sgst_paise" >= 0 and "sales_order_lines"."igst_paise" >= 0 and "sales_order_lines"."cess_paise" >= 0
        and "sales_order_lines"."total_paise" = "sales_order_lines"."taxable_paise" + "sales_order_lines"."cgst_paise" + "sales_order_lines"."sgst_paise" + "sales_order_lines"."igst_paise" + "sales_order_lines"."cess_paise"),
	CONSTRAINT "sales_order_lines_one_discount" CHECK (("sales_order_lines"."discount_bps" is null or "sales_order_lines"."discount_paise" is null)
        and "sales_order_lines"."discount_bps" between 0 and 10000 and "sales_order_lines"."discount_paise" >= 0),
	CONSTRAINT "sales_order_lines_rate_range" CHECK ("sales_order_lines"."rate_bps" between 0 and 10000),
	CONSTRAINT "sales_order_lines_hsn_format" CHECK ("sales_order_lines"."hsn_code" ~ '^[0-9]{4}([0-9]{2}){0,2}$')
);
--> statement-breakpoint
ALTER TABLE "sales_order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" "sales_order_status" DEFAULT 'draft' NOT NULL,
	"payment_terms" "payment_terms" NOT NULL,
	"advance_required_paise" bigint,
	"quotation_id" uuid,
	"credit_check" jsonb,
	"credit_override_approval" text,
	"credit_override_by_member_id" uuid,
	"credit_override_reason" text,
	"credit_overridden_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_member_id" uuid,
	"cancel_reason" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_member_id" uuid,
	"store_id" uuid NOT NULL,
	"bill_to_party_id" uuid NOT NULL,
	"influencer_party_id" uuid,
	"project_id" uuid,
	"ship_to_name" text,
	"ship_to_address" text,
	"ship_to_state_code" text,
	"price_mode" "price_mode" NOT NULL,
	"bill_discount_bps" integer,
	"bill_discount_paise" bigint,
	"priced_on" date NOT NULL,
	"place_of_supply_code" text NOT NULL,
	"supply_type" "supply_type" NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"cess_paise" bigint NOT NULL,
	"round_off_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"note" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_orders_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "sales_orders_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "sales_orders_number_format" CHECK ("sales_orders"."number" ~ '^SO-[0-9]{6,}$'),
	CONSTRAINT "sales_orders_confirmed" CHECK (("sales_orders"."status" = 'draft') = ("sales_orders"."confirmed_at" is null)
        and ("sales_orders"."confirmed_at" is null) = ("sales_orders"."confirmed_by_member_id" is null)),
	CONSTRAINT "sales_orders_cancelled" CHECK (("sales_orders"."status" in ('cancelled', 'closed')) = ("sales_orders"."cancelled_at" is not null)
        and ("sales_orders"."cancelled_at" is null) = ("sales_orders"."cancel_reason" is null)
        and ("sales_orders"."cancelled_at" is null) = ("sales_orders"."cancelled_by_member_id" is null)),
	CONSTRAINT "sales_orders_credit_override" CHECK (("sales_orders"."credit_override_approval" is null) = ("sales_orders"."credit_override_by_member_id" is null)
        and ("sales_orders"."credit_override_approval" is null) = ("sales_orders"."credit_override_reason" is null)
        and ("sales_orders"."credit_override_approval" is null) = ("sales_orders"."credit_overridden_at" is null)
        and "sales_orders"."credit_override_approval" in ('manager', 'owner')
        and ("sales_orders"."credit_override_approval" is null or "sales_orders"."credit_check" is not null)),
	CONSTRAINT "sales_orders_credit_check_postpaid" CHECK ("sales_orders"."credit_check" is null or ("sales_orders"."payment_terms" = 'postpaid' and "sales_orders"."status" <> 'draft')),
	CONSTRAINT "sales_orders_advance" CHECK ("sales_orders"."advance_required_paise" is null or ("sales_orders"."advance_required_paise" >= 0 and "sales_orders"."payment_terms" = 'partial')),
	CONSTRAINT "sales_orders_state_codes" CHECK ("sales_orders"."ship_to_state_code" ~ '^[0-9]{2}$' and "sales_orders"."place_of_supply_code" ~ '^[0-9]{2}$'),
	CONSTRAINT "sales_orders_bill_discount" CHECK (("sales_orders"."bill_discount_bps" is null or "sales_orders"."bill_discount_paise" is null)
        and "sales_orders"."bill_discount_bps" between 0 and 10000 and "sales_orders"."bill_discount_paise" >= 0),
	CONSTRAINT "sales_orders_amounts" CHECK ("sales_orders"."taxable_paise" >= 0 and "sales_orders"."cgst_paise" >= 0 and "sales_orders"."sgst_paise" >= 0
        and "sales_orders"."igst_paise" >= 0 and "sales_orders"."cess_paise" >= 0 and "sales_orders"."total_paise" >= 0
        and "sales_orders"."round_off_paise" between -50 and 50
        and "sales_orders"."total_paise" = "sales_orders"."taxable_paise" + "sales_orders"."cgst_paise" + "sales_orders"."sgst_paise" + "sales_orders"."igst_paise" + "sales_orders"."cess_paise" + "sales_orders"."round_off_paise"),
	CONSTRAINT "sales_orders_tax_by_supply" CHECK (case "sales_orders"."supply_type"
        when 'intra_state' then "sales_orders"."igst_paise" = 0 and "sales_orders"."cgst_paise" = "sales_orders"."sgst_paise"
        else "sales_orders"."cgst_paise" = 0 and "sales_orders"."sgst_paise" = 0 end),
	CONSTRAINT "sales_orders_note_length" CHECK (char_length("sales_orders"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "sales_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"status" "stock_reservation_status" DEFAULT 'open' NOT NULL,
	"consumed_by_type" text,
	"consumed_by_id" uuid,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "stock_reservations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "stock_reservations_quantity_positive" CHECK ("stock_reservations"."quantity" > 0),
	CONSTRAINT "stock_reservations_closed" CHECK (("stock_reservations"."status" = 'open') = ("stock_reservations"."closed_at" is null)
        and ("stock_reservations"."status" = 'consumed') = ("stock_reservations"."consumed_by_id" is not null)
        and ("stock_reservations"."consumed_by_id" is null) = ("stock_reservations"."consumed_by_type" is null)
        and "stock_reservations"."consumed_by_type" in ('tax_document', 'dispatch'))
);
--> statement-breakpoint
ALTER TABLE "stock_reservations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" DROP CONSTRAINT "loyalty_ledger_purchase";--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD COLUMN "opening_overdue_since" date;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD COLUMN "tax_document_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD COLUMN "order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD COLUMN "sales_order_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatch_lines" ADD CONSTRAINT "dispatch_lines_dispatch_fk" FOREIGN KEY ("organization_id","dispatch_id") REFERENCES "public"."dispatches"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_lines" ADD CONSTRAINT "dispatch_lines_invoice_line_fk" FOREIGN KEY ("organization_id","invoice_line_id") REFERENCES "public"."tax_document_lines"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_invoice_fk" FOREIGN KEY ("organization_id","invoice_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotation_fk" FOREIGN KEY ("organization_id","quotation_id") REFERENCES "public"."quotations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_tax_category_fk" FOREIGN KEY ("organization_id","tax_category_id") REFERENCES "public"."tax_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_root_fk" FOREIGN KEY ("organization_id","root_quotation_id") REFERENCES "public"."quotations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_bill_to_fk" FOREIGN KEY ("organization_id","bill_to_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_influencer_fk" FOREIGN KEY ("organization_id","influencer_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_sales_order_fk" FOREIGN KEY ("organization_id","sales_order_id") REFERENCES "public"."sales_orders"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_order_fk" FOREIGN KEY ("organization_id","order_id") REFERENCES "public"."sales_orders"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_fulfil_store_fk" FOREIGN KEY ("organization_id","fulfil_store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_tax_category_fk" FOREIGN KEY ("organization_id","tax_category_id") REFERENCES "public"."tax_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quotation_fk" FOREIGN KEY ("organization_id","quotation_id") REFERENCES "public"."quotations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_bill_to_fk" FOREIGN KEY ("organization_id","bill_to_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_influencer_fk" FOREIGN KEY ("organization_id","influencer_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_confirmed_by_fk" FOREIGN KEY ("organization_id","confirmed_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_credit_override_by_fk" FOREIGN KEY ("organization_id","credit_override_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_cancelled_by_fk" FOREIGN KEY ("organization_id","cancelled_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_order_line_fk" FOREIGN KEY ("organization_id","order_line_id") REFERENCES "public"."sales_order_lines"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dispatch_lines_invoice_line_idx" ON "dispatch_lines" USING btree ("organization_id","invoice_line_id");--> statement-breakpoint
CREATE INDEX "dispatches_invoice_idx" ON "dispatches" USING btree ("organization_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_one_live_version" ON "quotations" USING btree ("organization_id","number") WHERE "quotations"."status" <> 'superseded';--> statement-breakpoint
CREATE UNIQUE INDEX "quotations_sales_order_unique" ON "quotations" USING btree ("sales_order_id") WHERE "quotations"."sales_order_id" is not null;--> statement-breakpoint
CREATE INDEX "quotations_organization_created_idx" ON "quotations" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "quotations_bill_to_idx" ON "quotations" USING btree ("organization_id","bill_to_party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_quotation_unique" ON "sales_orders" USING btree ("quotation_id") WHERE "sales_orders"."quotation_id" is not null;--> statement-breakpoint
CREATE INDEX "sales_orders_organization_created_idx" ON "sales_orders" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "sales_orders_bill_to_status_idx" ON "sales_orders" USING btree ("organization_id","bill_to_party_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_reservations_one_open_per_line" ON "stock_reservations" USING btree ("order_line_id") WHERE "stock_reservations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "stock_reservations_open_idx" ON "stock_reservations" USING btree ("organization_id","store_id","variant_id") WHERE "stock_reservations"."status" = 'open';--> statement-breakpoint
CREATE INDEX "stock_reservations_order_line_idx" ON "stock_reservations" USING btree ("organization_id","order_line_id");--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_tax_document_fk" FOREIGN KEY ("organization_id","tax_document_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_order_line_fk" FOREIGN KEY ("organization_id","order_line_id") REFERENCES "public"."sales_order_lines"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_sales_order_fk" FOREIGN KEY ("organization_id","sales_order_id") REFERENCES "public"."sales_orders"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_ledger_invoice_purchase_unique" ON "loyalty_ledger" USING btree ("tax_document_id") WHERE "loyalty_ledger"."kind" = 'purchase' and "loyalty_ledger"."tax_document_id" is not null;--> statement-breakpoint
CREATE INDEX "loyalty_ledger_tax_document_idx" ON "loyalty_ledger" USING btree ("organization_id","tax_document_id") WHERE "loyalty_ledger"."tax_document_id" is not null;--> statement-breakpoint
CREATE INDEX "tax_document_lines_order_line_idx" ON "tax_document_lines" USING btree ("organization_id","order_line_id") WHERE "tax_document_lines"."order_line_id" is not null;--> statement-breakpoint
CREATE INDEX "tax_documents_sales_order_idx" ON "tax_documents" USING btree ("organization_id","sales_order_id") WHERE "tax_documents"."sales_order_id" is not null;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_purchase" CHECK (("loyalty_ledger"."kind" <> 'purchase' or num_nonnulls("loyalty_ledger"."manual_purchase_paise", "loyalty_ledger"."tax_document_id") = 1)
        and ("loyalty_ledger"."manual_purchase_paise" is null or ("loyalty_ledger"."kind" = 'purchase' and "loyalty_ledger"."manual_purchase_paise" > 0))
        and ("loyalty_ledger"."tax_document_id" is null or "loyalty_ledger"."kind" in ('purchase', 'adjust')));--> statement-breakpoint
CREATE POLICY "dispatch_lines_tenant_isolation" ON "dispatch_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("dispatch_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("dispatch_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "dispatches_tenant_isolation" ON "dispatches" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("dispatches"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("dispatches"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "quotation_lines_tenant_isolation" ON "quotation_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("quotation_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("quotation_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "quotations_tenant_isolation" ON "quotations" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("quotations"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("quotations"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sales_order_lines_tenant_isolation" ON "sales_order_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("sales_order_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("sales_order_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "sales_orders_tenant_isolation" ON "sales_orders" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("sales_orders"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("sales_orders"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_reservations_tenant_isolation" ON "stock_reservations" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("stock_reservations"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("stock_reservations"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);