CREATE TYPE "public"."product_type" AS ENUM('interior_paint', 'exterior_paint', 'primer', 'putty', 'enamel', 'wood_finish', 'waterproofing', 'texture', 'thinner', 'tool', 'other');--> statement-breakpoint
CREATE TYPE "public"."unit_of_measure" AS ENUM('ml', 'l', 'g', 'kg', 'piece', 'set', 'm');--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "brands" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "categories_not_own_parent" CHECK ("categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"organization_id" uuid NOT NULL,
	"barcode" text NOT NULL,
	"variant_id" uuid NOT NULL,
	CONSTRAINT "product_barcodes_organization_id_barcode_pk" PRIMARY KEY("organization_id","barcode")
);
--> statement-breakpoint
ALTER TABLE "product_barcodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"pack_size" numeric(12, 3) NOT NULL,
	"unit" "unit_of_measure" NOT NULL,
	"mrp_paise" bigint,
	"selling_price_paise" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_variants_organization_sku_unique" UNIQUE("organization_id","sku"),
	CONSTRAINT "product_variants_product_pack_unique" UNIQUE("product_id","pack_size","unit"),
	CONSTRAINT "product_variants_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "product_variants_sku_format" CHECK ("product_variants"."sku" ~ '^[A-Z0-9][A-Z0-9._/-]{1,39}$'),
	CONSTRAINT "product_variants_pack_size_positive" CHECK ("product_variants"."pack_size" > 0),
	CONSTRAINT "product_variants_prices_not_negative" CHECK ("product_variants"."mrp_paise" >= 0 and "product_variants"."selling_price_paise" >= 0),
	CONSTRAINT "product_variants_price_within_mrp" CHECK ("product_variants"."selling_price_paise" is null or "product_variants"."mrp_paise" is null or "product_variants"."selling_price_paise" <= "product_variants"."mrp_paise")
);
--> statement-breakpoint
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"category_id" uuid,
	"name" text NOT NULL,
	"type" "product_type" NOT NULL,
	"description" text,
	"hsn_code" text NOT NULL,
	"gst_rate_bps" integer NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "products_hsn_format" CHECK ("products"."hsn_code" ~ '^[0-9]{4}([0-9]{2}){0,2}$'),
	CONSTRAINT "products_gst_rate_range" CHECK ("products"."gst_rate_bps" between 0 and 10000)
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brands" ADD CONSTRAINT "brands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_fk" FOREIGN KEY ("organization_id","parent_id") REFERENCES "public"."categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_brand_fk" FOREIGN KEY ("organization_id","brand_id") REFERENCES "public"."brands"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brands_organization_name_unique" ON "brands" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "categories_organization_parent_name_unique" ON "categories" USING btree ("organization_id",coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE INDEX "product_barcodes_variant_id_idx" ON "product_barcodes" USING btree ("variant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "products_organization_brand_name_unique" ON "products" USING btree ("organization_id","brand_id",lower("name"));--> statement-breakpoint
CREATE INDEX "products_organization_name_idx" ON "products" USING btree ("organization_id","name");--> statement-breakpoint
CREATE POLICY "brands_tenant_isolation" ON "brands" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brands"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brands"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "categories_tenant_isolation" ON "categories" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("categories"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("categories"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "product_barcodes_tenant_isolation" ON "product_barcodes" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("product_barcodes"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("product_barcodes"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "product_variants_tenant_isolation" ON "product_variants" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("product_variants"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("product_variants"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "products_tenant_isolation" ON "products" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("products"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("products"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);