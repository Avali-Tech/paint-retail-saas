CREATE TYPE "public"."stock_movement_type" AS ENUM('opening', 'purchase_receipt', 'purchase_return', 'transfer_in', 'transfer_out', 'sale', 'sale_return', 'adjustment', 'damage', 'count_correction');--> statement-breakpoint
CREATE TABLE "stock_balances" (
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"on_hand" numeric(14, 3) DEFAULT 0 NOT NULL,
	"reserved" numeric(14, 3) DEFAULT 0 NOT NULL,
	"avg_cost_paise" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_balances_store_id_variant_id_pk" PRIMARY KEY("store_id","variant_id"),
	CONSTRAINT "stock_balances_on_hand_not_negative" CHECK ("stock_balances"."on_hand" >= 0),
	CONSTRAINT "stock_balances_reserved_within_on_hand" CHECK ("stock_balances"."reserved" >= 0 and "stock_balances"."reserved" <= "stock_balances"."on_hand")
);
--> statement-breakpoint
ALTER TABLE "stock_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"movement_type" "stock_movement_type" NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"unit_cost_paise" bigint,
	"reference_type" text,
	"reference_id" uuid,
	"note" text,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_ledger_quantity_sign" CHECK (case
        when "stock_ledger"."movement_type" in ('opening', 'purchase_receipt', 'transfer_in', 'sale_return') then "stock_ledger"."quantity" > 0
        when "stock_ledger"."movement_type" in ('purchase_return', 'transfer_out', 'sale', 'damage') then "stock_ledger"."quantity" < 0
        else "stock_ledger"."quantity" <> 0
      end),
	CONSTRAINT "stock_ledger_unit_cost_not_negative" CHECK ("stock_ledger"."unit_cost_paise" >= 0)
);
--> statement-breakpoint
ALTER TABLE "stock_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_balances_organization_variant_idx" ON "stock_balances" USING btree ("organization_id","variant_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_store_variant_created_idx" ON "stock_ledger" USING btree ("organization_id","store_id","variant_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_ledger_reference_idx" ON "stock_ledger" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE POLICY "stock_balances_tenant_isolation" ON "stock_balances" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("stock_balances"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("stock_balances"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stock_ledger_tenant_isolation" ON "stock_ledger" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("stock_ledger"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("stock_ledger"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);