CREATE TYPE "public"."gst_registration_type" AS ENUM('regular', 'composition', 'unregistered');--> statement-breakpoint
CREATE TABLE "tax_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_categories_organization_key_unique" UNIQUE("organization_id","key"),
	CONSTRAINT "tax_categories_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "tax_categories_default_active" CHECK (not "tax_categories"."is_default" or "tax_categories"."is_active")
);
--> statement-breakpoint
ALTER TABLE "tax_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"tax_category_id" uuid NOT NULL,
	"rate_bps" integer NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_category_from_unique" UNIQUE("tax_category_id","effective_from"),
	CONSTRAINT "tax_rates_rate_range" CHECK ("tax_rates"."rate_bps" between 0 and 10000),
	CONSTRAINT "tax_rates_period_order" CHECK ("tax_rates"."effective_to" is null or "tax_rates"."effective_to" >= "tax_rates"."effective_from")
);
--> statement-breakpoint
ALTER TABLE "tax_rates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN "place_of_supply" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "tax_category_id" uuid;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "gst_state_code" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "gst_registration_type" "gst_registration_type" DEFAULT 'unregistered' NOT NULL;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "trade_name" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "address_line" text;--> statement-breakpoint
ALTER TABLE "stores" ADD COLUMN "pincode" text;--> statement-breakpoint
ALTER TABLE "tax_categories" ADD CONSTRAINT "tax_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_category_fk" FOREIGN KEY ("organization_id","tax_category_id") REFERENCES "public"."tax_categories"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_categories_organization_name_unique" ON "tax_categories" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "tax_categories_one_default" ON "tax_categories" USING btree ("organization_id") WHERE "tax_categories"."is_default";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tax_category_fk" FOREIGN KEY ("organization_id","tax_category_id") REFERENCES "public"."tax_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_tax_category_idx" ON "products" USING btree ("organization_id","tax_category_id");--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_place_of_supply_format" CHECK ("parties"."place_of_supply" ~ '^[0-9]{2}$');--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_gst_state_code_format" CHECK ("stores"."gst_state_code" ~ '^[0-9]{2}$');--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_pincode_format" CHECK ("stores"."pincode" ~ '^[1-9][0-9]{5}$');--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_gstin_in_state" CHECK ("stores"."gstin" is null or "stores"."gst_state_code" is null or left("stores"."gstin", 2) = "stores"."gst_state_code");--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_registration_complete" CHECK ("stores"."gst_registration_type" = 'unregistered' or ("stores"."gstin" is not null and "stores"."gst_state_code" is not null and "stores"."legal_name" is not null));--> statement-breakpoint
CREATE POLICY "tax_categories_tenant_isolation" ON "tax_categories" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("tax_categories"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("tax_categories"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tax_rates_tenant_isolation" ON "tax_rates" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("tax_rates"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("tax_rates"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);