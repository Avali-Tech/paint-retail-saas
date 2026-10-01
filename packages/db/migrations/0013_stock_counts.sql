CREATE TYPE "public"."stock_count_scope" AS ENUM('full', 'brand', 'category');--> statement-breakpoint
CREATE TYPE "public"."stock_count_status" AS ENUM('counting', 'submitted', 'approved', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."variance_reason" AS ENUM('damage', 'theft', 'expiry', 'counting_error', 'other');--> statement-breakpoint
CREATE TABLE "stock_count_lines" (
	"organization_id" uuid NOT NULL,
	"count_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"expected_quantity" numeric(14, 3) NOT NULL,
	"counted_quantity" numeric(14, 3),
	"reason" "variance_reason",
	"counted_by_member_id" uuid,
	"counted_at" timestamp with time zone,
	CONSTRAINT "stock_count_lines_count_id_variant_id_pk" PRIMARY KEY("count_id","variant_id"),
	CONSTRAINT "stock_count_lines_expected_not_negative" CHECK ("stock_count_lines"."expected_quantity" >= 0),
	CONSTRAINT "stock_count_lines_counted_not_negative" CHECK ("stock_count_lines"."counted_quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stock_count_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_counts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"scope" "stock_count_scope" NOT NULL,
	"scope_id" uuid,
	"status" "stock_count_status" DEFAULT 'counting' NOT NULL,
	"note" text,
	"closing_reason" text,
	"started_by_member_id" uuid NOT NULL,
	"submitted_by_member_id" uuid,
	"approved_by_member_id" uuid,
	"closed_by_member_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_counts_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "stock_counts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "stock_counts_scope_id_matches_scope" CHECK (("stock_counts"."scope" = 'full') = ("stock_counts"."scope_id" is null))
);
--> statement-breakpoint
ALTER TABLE "stock_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_count_fk" FOREIGN KEY ("organization_id","count_id") REFERENCES "public"."stock_counts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_started_by_fk" FOREIGN KEY ("organization_id","started_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_counts_one_open_per_store" ON "stock_counts" USING btree ("organization_id","store_id") WHERE "stock_counts"."status" in ('counting', 'submitted');--> statement-breakpoint
CREATE POLICY "stock_count_lines_tenant_isolation" ON "stock_count_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("stock_count_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("stock_count_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_counts_tenant_isolation" ON "stock_counts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("stock_counts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("stock_counts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);