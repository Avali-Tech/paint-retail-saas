CREATE TYPE "public"."brand_benefit_money_form" AS ENUM('credit_note', 'payment');--> statement-breakpoint
CREATE TYPE "public"."brand_benefit_receipt_kind" AS ENUM('money', 'free_goods', 'points');--> statement-breakpoint
CREATE TYPE "public"."brand_claim_status" AS ENUM('filed', 'acknowledged', 'settled', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."brand_scheme_benefit_kind" AS ENUM('rebate', 'per_litre', 'free_goods', 'points');--> statement-breakpoint
CREATE TYPE "public"."brand_scheme_date_basis" AS ENUM('grn_date', 'invoice_date');--> statement-breakpoint
CREATE TYPE "public"."brand_scheme_measure" AS ENUM('value', 'litres');--> statement-breakpoint
CREATE TYPE "public"."brand_scheme_mode" AS ENUM('retro', 'incremental');--> statement-breakpoint
CREATE TYPE "public"."brand_scheme_status" AS ENUM('draft', 'active', 'closed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'scheme_slab_near';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'scheme_claim_overdue';--> statement-breakpoint
CREATE TABLE "brand_benefit_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"claim_id" uuid,
	"kind" "brand_benefit_receipt_kind" NOT NULL,
	"received_on" date NOT NULL,
	"amount_paise" bigint,
	"money_form" "brand_benefit_money_form",
	"variant_id" uuid,
	"units" integer,
	"goods_receipt_id" uuid,
	"label" text,
	"points" integer,
	"reference" text,
	"note" text,
	"recorded_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_benefit_receipts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "brand_benefit_receipts_kind" CHECK (("brand_benefit_receipts"."kind" = 'money') = ("brand_benefit_receipts"."amount_paise" is not null)
        and ("brand_benefit_receipts"."kind" = 'money') = ("brand_benefit_receipts"."money_form" is not null)
        and ("brand_benefit_receipts"."kind" = 'free_goods') = ("brand_benefit_receipts"."variant_id" is not null)
        and ("brand_benefit_receipts"."kind" = 'free_goods') = ("brand_benefit_receipts"."units" is not null)
        and ("brand_benefit_receipts"."goods_receipt_id" is null or "brand_benefit_receipts"."kind" = 'free_goods')
        and ("brand_benefit_receipts"."kind" = 'points') = ("brand_benefit_receipts"."label" is not null)
        and ("brand_benefit_receipts"."kind" = 'points') = ("brand_benefit_receipts"."points" is not null)),
	CONSTRAINT "brand_benefit_receipts_amounts" CHECK ("brand_benefit_receipts"."amount_paise" <> 0 and abs("brand_benefit_receipts"."amount_paise") <= 100000000000
        and "brand_benefit_receipts"."units" <> 0 and abs("brand_benefit_receipts"."units") <= 1000000
        and "brand_benefit_receipts"."points" <> 0 and abs("brand_benefit_receipts"."points") <= 100000000),
	CONSTRAINT "brand_benefit_receipts_text" CHECK ("brand_benefit_receipts"."label" = btrim("brand_benefit_receipts"."label") and char_length("brand_benefit_receipts"."label") between 1 and 60
        and char_length("brand_benefit_receipts"."reference") between 1 and 60 and char_length("brand_benefit_receipts"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "brand_benefit_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"number" text NOT NULL,
	"filed_on" date NOT NULL,
	"claimed_paise" bigint NOT NULL,
	"brand_reference" text,
	"note" text,
	"status" "brand_claim_status" DEFAULT 'filed' NOT NULL,
	"filed_by_member_id" uuid NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_member_id" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_claims_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "brand_claims_scheme_id_unique" UNIQUE("organization_id","id","scheme_id"),
	CONSTRAINT "brand_claims_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "brand_claims_number_format" CHECK ("brand_claims"."number" ~ '^SC-[0-9]{6,}$'),
	CONSTRAINT "brand_claims_claimed" CHECK ("brand_claims"."claimed_paise" >= 0),
	CONSTRAINT "brand_claims_resolved" CHECK (("brand_claims"."status" in ('settled', 'rejected', 'withdrawn')) = ("brand_claims"."resolved_at" is not null)
        and ("brand_claims"."resolved_by_member_id" is null or "brand_claims"."resolved_at" is not null)
        and ("brand_claims"."resolution_note" is null or "brand_claims"."resolved_at" is not null)),
	CONSTRAINT "brand_claims_text" CHECK (char_length("brand_claims"."brand_reference") between 1 and 60
        and char_length("brand_claims"."note") <= 500 and char_length("brand_claims"."resolution_note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "brand_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_scheme_benefits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"slab_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" "brand_scheme_benefit_kind" NOT NULL,
	"basis_points" integer,
	"paise_per_litre" integer,
	"variant_id" uuid,
	"units" integer,
	"per_millilitres" bigint,
	"label" text,
	"points" integer,
	CONSTRAINT "brand_scheme_benefits_position_unique" UNIQUE("slab_id","position"),
	CONSTRAINT "brand_scheme_benefits_position" CHECK ("brand_scheme_benefits"."position" between 1 and 10),
	CONSTRAINT "brand_scheme_benefits_kind" CHECK (("brand_scheme_benefits"."kind" = 'rebate') = ("brand_scheme_benefits"."basis_points" is not null)
        and ("brand_scheme_benefits"."kind" = 'per_litre') = ("brand_scheme_benefits"."paise_per_litre" is not null)
        and ("brand_scheme_benefits"."kind" = 'free_goods') = ("brand_scheme_benefits"."variant_id" is not null)
        and ("brand_scheme_benefits"."kind" = 'free_goods') = ("brand_scheme_benefits"."units" is not null)
        and ("brand_scheme_benefits"."per_millilitres" is null or "brand_scheme_benefits"."kind" = 'free_goods')
        and ("brand_scheme_benefits"."kind" = 'points') = ("brand_scheme_benefits"."label" is not null)
        and ("brand_scheme_benefits"."kind" = 'points') = ("brand_scheme_benefits"."points" is not null)),
	CONSTRAINT "brand_scheme_benefits_amounts" CHECK ("brand_scheme_benefits"."basis_points" between 1 and 10000 and "brand_scheme_benefits"."paise_per_litre" between 1 and 100000000
        and "brand_scheme_benefits"."units" between 1 and 1000000 and "brand_scheme_benefits"."per_millilitres" > 0
        and "brand_scheme_benefits"."points" between 1 and 100000000
        and "brand_scheme_benefits"."label" = btrim("brand_scheme_benefits"."label") and char_length("brand_scheme_benefits"."label") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "brand_scheme_benefits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_scheme_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"product_id" uuid,
	"category_id" uuid,
	CONSTRAINT "brand_scheme_items_one" CHECK (num_nonnulls("brand_scheme_items"."product_id", "brand_scheme_items"."category_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "brand_scheme_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_scheme_slabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scheme_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"target" bigint NOT NULL,
	CONSTRAINT "brand_scheme_slabs_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "brand_scheme_slabs_scheme_id_unique" UNIQUE("organization_id","id","scheme_id"),
	CONSTRAINT "brand_scheme_slabs_position_unique" UNIQUE("scheme_id","position"),
	CONSTRAINT "brand_scheme_slabs_target_unique" UNIQUE("scheme_id","target"),
	CONSTRAINT "brand_scheme_slabs_position" CHECK ("brand_scheme_slabs"."position" between 1 and 20),
	CONSTRAINT "brand_scheme_slabs_target" CHECK ("brand_scheme_slabs"."target" > 0 and "brand_scheme_slabs"."target" <= 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "brand_scheme_slabs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "brand_schemes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"brand_reference" text,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"measure" "brand_scheme_measure" NOT NULL,
	"mode" "brand_scheme_mode" DEFAULT 'retro' NOT NULL,
	"settlement_days" integer,
	"date_basis" "brand_scheme_date_basis" DEFAULT 'grn_date' NOT NULL,
	"status" "brand_scheme_status" DEFAULT 'draft' NOT NULL,
	"note" text,
	"created_by_member_id" uuid NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_by_member_id" uuid,
	"end_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_schemes_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "brand_schemes_text" CHECK ("brand_schemes"."name" = btrim("brand_schemes"."name") and char_length("brand_schemes"."name") between 1 and 120
        and char_length("brand_schemes"."brand_reference") between 1 and 60
        and char_length("brand_schemes"."note") <= 500 and char_length("brand_schemes"."end_note") <= 500),
	CONSTRAINT "brand_schemes_period" CHECK ("brand_schemes"."ends_on" >= "brand_schemes"."starts_on" and "brand_schemes"."ends_on" - "brand_schemes"."starts_on" < 731),
	CONSTRAINT "brand_schemes_settlement_days" CHECK ("brand_schemes"."settlement_days" between 0 and 365),
	CONSTRAINT "brand_schemes_ended" CHECK (("brand_schemes"."status" in ('closed', 'cancelled')) = ("brand_schemes"."ended_at" is not null)
        and ("brand_schemes"."ended_by_member_id" is null or "brand_schemes"."ended_at" is not null)
        and ("brand_schemes"."end_note" is null or "brand_schemes"."ended_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "brand_schemes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brand_benefit_receipts" ADD CONSTRAINT "brand_benefit_receipts_scheme_fk" FOREIGN KEY ("organization_id","scheme_id") REFERENCES "public"."brand_schemes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_benefit_receipts" ADD CONSTRAINT "brand_benefit_receipts_claim_fk" FOREIGN KEY ("organization_id","claim_id","scheme_id") REFERENCES "public"."brand_claims"("organization_id","id","scheme_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_benefit_receipts" ADD CONSTRAINT "brand_benefit_receipts_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_benefit_receipts" ADD CONSTRAINT "brand_benefit_receipts_goods_receipt_fk" FOREIGN KEY ("organization_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_benefit_receipts" ADD CONSTRAINT "brand_benefit_receipts_recorded_by_fk" FOREIGN KEY ("organization_id","recorded_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_claims" ADD CONSTRAINT "brand_claims_scheme_fk" FOREIGN KEY ("organization_id","scheme_id") REFERENCES "public"."brand_schemes"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_claims" ADD CONSTRAINT "brand_claims_filed_by_fk" FOREIGN KEY ("organization_id","filed_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_claims" ADD CONSTRAINT "brand_claims_resolved_by_fk" FOREIGN KEY ("organization_id","resolved_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_scheme_benefits" ADD CONSTRAINT "brand_scheme_benefits_slab_fk" FOREIGN KEY ("organization_id","slab_id","scheme_id") REFERENCES "public"."brand_scheme_slabs"("organization_id","id","scheme_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_scheme_benefits" ADD CONSTRAINT "brand_scheme_benefits_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_scheme_items" ADD CONSTRAINT "brand_scheme_items_scheme_fk" FOREIGN KEY ("organization_id","scheme_id") REFERENCES "public"."brand_schemes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_scheme_items" ADD CONSTRAINT "brand_scheme_items_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_scheme_items" ADD CONSTRAINT "brand_scheme_items_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_scheme_slabs" ADD CONSTRAINT "brand_scheme_slabs_scheme_fk" FOREIGN KEY ("organization_id","scheme_id") REFERENCES "public"."brand_schemes"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_schemes" ADD CONSTRAINT "brand_schemes_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_schemes" ADD CONSTRAINT "brand_schemes_brand_fk" FOREIGN KEY ("organization_id","brand_id") REFERENCES "public"."brands"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_schemes" ADD CONSTRAINT "brand_schemes_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_schemes" ADD CONSTRAINT "brand_schemes_ended_by_fk" FOREIGN KEY ("organization_id","ended_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_benefit_receipts_scheme_idx" ON "brand_benefit_receipts" USING btree ("organization_id","scheme_id","received_on");--> statement-breakpoint
CREATE INDEX "brand_claims_scheme_idx" ON "brand_claims" USING btree ("organization_id","scheme_id");--> statement-breakpoint
CREATE INDEX "brand_scheme_benefits_scheme_idx" ON "brand_scheme_benefits" USING btree ("organization_id","scheme_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_scheme_items_product_unique" ON "brand_scheme_items" USING btree ("scheme_id","product_id") WHERE "brand_scheme_items"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_scheme_items_category_unique" ON "brand_scheme_items" USING btree ("scheme_id","category_id") WHERE "brand_scheme_items"."category_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_schemes_brand_name_unique" ON "brand_schemes" USING btree ("organization_id","brand_id",lower("name"));--> statement-breakpoint
CREATE INDEX "brand_schemes_brand_period_idx" ON "brand_schemes" USING btree ("organization_id","brand_id","starts_on","ends_on");--> statement-breakpoint
CREATE POLICY "brand_benefit_receipts_tenant_isolation" ON "brand_benefit_receipts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_benefit_receipts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_benefit_receipts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "brand_claims_tenant_isolation" ON "brand_claims" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_claims"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_claims"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "brand_scheme_benefits_tenant_isolation" ON "brand_scheme_benefits" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_scheme_benefits"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_scheme_benefits"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "brand_scheme_items_tenant_isolation" ON "brand_scheme_items" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_scheme_items"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_scheme_items"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "brand_scheme_slabs_tenant_isolation" ON "brand_scheme_slabs" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_scheme_slabs"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_scheme_slabs"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "brand_schemes_tenant_isolation" ON "brand_schemes" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("brand_schemes"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("brand_schemes"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);