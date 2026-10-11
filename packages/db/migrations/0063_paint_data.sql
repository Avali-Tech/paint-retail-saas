CREATE TYPE "public"."estimate_status" AS ENUM('draft', 'converted');--> statement-breakpoint
CREATE TYPE "public"."estimate_tier" AS ENUM('good', 'better', 'best');--> statement-breakpoint
CREATE TYPE "public"."surface_condition" AS ENUM('new', 'repaint', 'damaged');--> statement-breakpoint
CREATE TYPE "public"."surface_kind" AS ENUM('interior_wall', 'ceiling', 'exterior', 'wood', 'metal');--> statement-breakpoint
CREATE TABLE "estimate_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"tier" "estimate_tier" NOT NULL,
	"product_id" uuid NOT NULL,
	"primer_product_id" uuid,
	"putty_product_id" uuid,
	"litres" numeric(12, 3),
	"lines" jsonb,
	"total_paise" bigint,
	"computed_at" timestamp with time zone,
	CONSTRAINT "estimate_options_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "estimate_options_estimate_tier_unique" UNIQUE("estimate_id","tier"),
	CONSTRAINT "estimate_options_computed" CHECK (("estimate_options"."computed_at" is null) = ("estimate_options"."litres" is null)
        and ("estimate_options"."computed_at" is null) = ("estimate_options"."lines" is null)
        and ("estimate_options"."computed_at" is null) = ("estimate_options"."total_paise" is null)
        and "estimate_options"."litres" >= 0 and "estimate_options"."total_paise" >= 0
        and jsonb_typeof("estimate_options"."lines") = 'array')
);
--> statement-breakpoint
ALTER TABLE "estimate_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "estimate_surfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"room" text NOT NULL,
	"kind" "surface_kind" NOT NULL,
	"area_sqft" numeric(10, 2),
	"length_ft" numeric(8, 2),
	"height_ft" numeric(8, 2),
	"openings_sqft" numeric(10, 2) DEFAULT 0 NOT NULL,
	"condition" "surface_condition" NOT NULL,
	"coats" integer,
	"primer" boolean NOT NULL,
	"putty" boolean NOT NULL,
	CONSTRAINT "estimate_surfaces_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "estimate_surfaces_estimate_position_unique" UNIQUE("estimate_id","position"),
	CONSTRAINT "estimate_surfaces_position_positive" CHECK ("estimate_surfaces"."position" > 0),
	CONSTRAINT "estimate_surfaces_room" CHECK ("estimate_surfaces"."room" = btrim("estimate_surfaces"."room") and char_length("estimate_surfaces"."room") between 1 and 60),
	CONSTRAINT "estimate_surfaces_size" CHECK (("estimate_surfaces"."area_sqft" is null) <> ("estimate_surfaces"."length_ft" is null)
        and ("estimate_surfaces"."length_ft" is null) = ("estimate_surfaces"."height_ft" is null)
        and "estimate_surfaces"."area_sqft" > 0 and "estimate_surfaces"."length_ft" > 0 and "estimate_surfaces"."height_ft" > 0),
	CONSTRAINT "estimate_surfaces_openings" CHECK ("estimate_surfaces"."openings_sqft" >= 0
        and "estimate_surfaces"."openings_sqft" <= coalesce("estimate_surfaces"."area_sqft", "estimate_surfaces"."length_ft" * "estimate_surfaces"."height_ft")),
	CONSTRAINT "estimate_surfaces_coats_range" CHECK ("estimate_surfaces"."coats" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "estimate_surfaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"status" "estimate_status" DEFAULT 'draft' NOT NULL,
	"store_id" uuid NOT NULL,
	"party_id" uuid,
	"project_id" uuid,
	"title" text,
	"wastage_bps" integer DEFAULT 500 NOT NULL,
	"note" text,
	"quotation_id" uuid,
	"converted_tier" "estimate_tier",
	"converted_at" timestamp with time zone,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estimates_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "estimates_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "estimates_number_format" CHECK ("estimates"."number" ~ '^ES-[0-9]{6,}$'),
	CONSTRAINT "estimates_wastage_range" CHECK ("estimates"."wastage_bps" between 0 and 5000),
	CONSTRAINT "estimates_converted" CHECK (("estimates"."status" = 'converted') = ("estimates"."quotation_id" is not null)
        and ("estimates"."quotation_id" is null) = ("estimates"."converted_tier" is null)
        and ("estimates"."quotation_id" is null) = ("estimates"."converted_at" is null)),
	CONSTRAINT "estimates_text_lengths" CHECK (char_length("estimates"."title") between 1 and 120 and char_length("estimates"."note") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "estimates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tint_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"party_id" uuid,
	"project_id" uuid,
	"quotation_line_id" uuid,
	"sales_order_line_id" uuid,
	"invoice_line_id" uuid,
	"brand_id" uuid NOT NULL,
	"shade_code" text NOT NULL,
	"shade_name" text,
	"base_variant_id" uuid NOT NULL,
	"pack_quantity" numeric(14, 3) NOT NULL,
	"colorant_cost_paise" bigint,
	"tint_charge_paise" bigint DEFAULT 0 NOT NULL,
	"machine" text,
	"formula" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tint_records_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tint_records_one_line" CHECK (num_nonnulls("tint_records"."quotation_line_id", "tint_records"."sales_order_line_id", "tint_records"."invoice_line_id") = 1),
	CONSTRAINT "tint_records_shade_code_format" CHECK ("tint_records"."shade_code" = upper("tint_records"."shade_code") and "tint_records"."shade_code" ~ '^[^[:space:]]+( [^[:space:]]+)*$'
        and char_length("tint_records"."shade_code") <= 40),
	CONSTRAINT "tint_records_pack_quantity_positive" CHECK ("tint_records"."pack_quantity" > 0),
	CONSTRAINT "tint_records_amounts" CHECK ("tint_records"."colorant_cost_paise" >= 0 and "tint_records"."tint_charge_paise" >= 0),
	CONSTRAINT "tint_records_formula" CHECK (jsonb_typeof("tint_records"."formula") = 'array' and jsonb_array_length("tint_records"."formula") <= 16),
	CONSTRAINT "tint_records_text_lengths" CHECK (char_length("tint_records"."shade_name") between 1 and 80 and char_length("tint_records"."machine") between 1 and 80
        and char_length("tint_records"."note") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "tint_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "coverage_sqft_per_litre" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "default_coats" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "is_tintable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "estimate_options" ADD CONSTRAINT "estimate_options_estimate_fk" FOREIGN KEY ("organization_id","estimate_id") REFERENCES "public"."estimates"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_options" ADD CONSTRAINT "estimate_options_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_options" ADD CONSTRAINT "estimate_options_primer_product_fk" FOREIGN KEY ("organization_id","primer_product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_options" ADD CONSTRAINT "estimate_options_putty_product_fk" FOREIGN KEY ("organization_id","putty_product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_surfaces" ADD CONSTRAINT "estimate_surfaces_estimate_fk" FOREIGN KEY ("organization_id","estimate_id") REFERENCES "public"."estimates"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_quotation_fk" FOREIGN KEY ("organization_id","quotation_id") REFERENCES "public"."quotations"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_quotation_line_fk" FOREIGN KEY ("organization_id","quotation_line_id") REFERENCES "public"."quotation_lines"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_sales_order_line_fk" FOREIGN KEY ("organization_id","sales_order_line_id") REFERENCES "public"."sales_order_lines"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_invoice_line_fk" FOREIGN KEY ("organization_id","invoice_line_id") REFERENCES "public"."tax_document_lines"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_brand_fk" FOREIGN KEY ("organization_id","brand_id") REFERENCES "public"."brands"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_base_variant_fk" FOREIGN KEY ("organization_id","base_variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tint_records" ADD CONSTRAINT "tint_records_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_quotation_unique" ON "estimates" USING btree ("quotation_id") WHERE "estimates"."quotation_id" is not null;--> statement-breakpoint
CREATE INDEX "estimates_organization_created_idx" ON "estimates" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "estimates_party_idx" ON "estimates" USING btree ("organization_id","party_id") WHERE "estimates"."party_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tint_records_quotation_line_unique" ON "tint_records" USING btree ("quotation_line_id") WHERE "tint_records"."quotation_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tint_records_sales_order_line_unique" ON "tint_records" USING btree ("sales_order_line_id") WHERE "tint_records"."sales_order_line_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "tint_records_invoice_line_unique" ON "tint_records" USING btree ("invoice_line_id") WHERE "tint_records"."invoice_line_id" is not null;--> statement-breakpoint
CREATE INDEX "tint_records_party_shade_idx" ON "tint_records" USING btree ("organization_id","party_id","shade_code","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "tint_records_project_idx" ON "tint_records" USING btree ("organization_id","project_id","created_at" DESC NULLS FIRST) WHERE "tint_records"."project_id" is not null;--> statement-breakpoint
CREATE INDEX "tint_records_shade_idx" ON "tint_records" USING btree ("organization_id","shade_code","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "tint_records_organization_created_idx" ON "tint_records" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_coverage_positive" CHECK ("products"."coverage_sqft_per_litre" > 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_default_coats_range" CHECK ("products"."default_coats" between 1 and 5);--> statement-breakpoint
CREATE POLICY "estimate_options_tenant_isolation" ON "estimate_options" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("estimate_options"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("estimate_options"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "estimate_surfaces_tenant_isolation" ON "estimate_surfaces" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("estimate_surfaces"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("estimate_surfaces"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "estimates_tenant_isolation" ON "estimates" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("estimates"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("estimates"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tint_records_tenant_isolation" ON "tint_records" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("tint_records"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("tint_records"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);