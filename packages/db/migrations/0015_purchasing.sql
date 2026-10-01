CREATE TYPE "public"."purchase_order_status" AS ENUM('open', 'partially_received', 'received', 'closed', 'cancelled');--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"organization_id" uuid NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"free_quantity" numeric(14, 3) DEFAULT 0 NOT NULL,
	"unit_cost_paise" bigint,
	CONSTRAINT "goods_receipt_lines_goods_receipt_id_variant_id_pk" PRIMARY KEY("goods_receipt_id","variant_id"),
	CONSTRAINT "goods_receipt_lines_quantities" CHECK ("goods_receipt_lines"."quantity" >= 0 and "goods_receipt_lines"."free_quantity" >= 0 and "goods_receipt_lines"."quantity" + "goods_receipt_lines"."free_quantity" > 0),
	CONSTRAINT "goods_receipt_lines_cost_not_negative" CHECK ("goods_receipt_lines"."unit_cost_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"supplier_party_id" uuid NOT NULL,
	"purchase_order_id" uuid,
	"supplier_invoice_number" text,
	"supplier_invoice_date" date,
	"note" text,
	"received_by_member_id" uuid NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goods_receipts_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "goods_receipts_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "goods_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"ordered_quantity" numeric(14, 3) NOT NULL,
	"unit_cost_paise" bigint,
	"received_quantity" numeric(14, 3) DEFAULT 0 NOT NULL,
	CONSTRAINT "purchase_order_lines_purchase_order_id_variant_id_pk" PRIMARY KEY("purchase_order_id","variant_id"),
	CONSTRAINT "purchase_order_lines_ordered_positive" CHECK ("purchase_order_lines"."ordered_quantity" > 0),
	CONSTRAINT "purchase_order_lines_cost_not_negative" CHECK ("purchase_order_lines"."unit_cost_paise" >= 0),
	CONSTRAINT "purchase_order_lines_received_within_ordered" CHECK ("purchase_order_lines"."received_quantity" >= 0 and "purchase_order_lines"."received_quantity" <= "purchase_order_lines"."ordered_quantity")
);
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"supplier_party_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"status" "purchase_order_status" DEFAULT 'open' NOT NULL,
	"expected_date" date,
	"note" text,
	"closing_reason" text,
	"created_by_member_id" uuid NOT NULL,
	"closed_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_orders_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "purchase_orders_organization_id_id_unique" UNIQUE("organization_id","id")
);
--> statement-breakpoint
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier_products" (
	"organization_id" uuid NOT NULL,
	"supplier_party_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"supplier_sku" text,
	"last_cost_paise" bigint,
	"last_received_at" timestamp with time zone,
	CONSTRAINT "supplier_products_supplier_party_id_variant_id_pk" PRIMARY KEY("supplier_party_id","variant_id"),
	CONSTRAINT "supplier_products_last_cost_not_negative" CHECK ("supplier_products"."last_cost_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier_profiles" (
	"party_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_terms_days" integer DEFAULT 0 NOT NULL,
	"lead_time_days" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_profiles_payment_terms_range" CHECK ("supplier_profiles"."payment_terms_days" between 0 and 365),
	CONSTRAINT "supplier_profiles_lead_time_range" CHECK ("supplier_profiles"."lead_time_days" between 0 and 365)
);
--> statement-breakpoint
ALTER TABLE "supplier_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_receipt_fk" FOREIGN KEY ("organization_id","goods_receipt_id") REFERENCES "public"."goods_receipts"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_supplier_fk" FOREIGN KEY ("organization_id","supplier_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_orders"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_order_fk" FOREIGN KEY ("organization_id","purchase_order_id") REFERENCES "public"."purchase_orders"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_fk" FOREIGN KEY ("organization_id","supplier_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_party_fk" FOREIGN KEY ("organization_id","supplier_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_products" ADD CONSTRAINT "supplier_products_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_profiles" ADD CONSTRAINT "supplier_profiles_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_supplier_invoice_unique" ON "goods_receipts" USING btree ("organization_id","supplier_party_id",lower("supplier_invoice_number")) WHERE "goods_receipts"."supplier_invoice_number" is not null;--> statement-breakpoint
CREATE INDEX "goods_receipts_purchase_order_idx" ON "goods_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_store_status_idx" ON "purchase_orders" USING btree ("organization_id","store_id","status");--> statement-breakpoint
CREATE POLICY "goods_receipt_lines_tenant_isolation" ON "goods_receipt_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("goods_receipt_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("goods_receipt_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "goods_receipts_tenant_isolation" ON "goods_receipts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("goods_receipts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("goods_receipts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_order_lines_tenant_isolation" ON "purchase_order_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("purchase_order_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("purchase_order_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "purchase_orders_tenant_isolation" ON "purchase_orders" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("purchase_orders"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("purchase_orders"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "supplier_products_tenant_isolation" ON "supplier_products" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("supplier_products"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("supplier_products"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "supplier_profiles_tenant_isolation" ON "supplier_profiles" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("supplier_profiles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("supplier_profiles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);