CREATE TABLE "reorder_rules" (
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"min_quantity" numeric(14, 3) NOT NULL,
	"reorder_level" numeric(14, 3) NOT NULL,
	"max_quantity" numeric(14, 3) NOT NULL,
	"updated_by_member_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reorder_rules_store_id_variant_id_pk" PRIMARY KEY("store_id","variant_id"),
	CONSTRAINT "reorder_rules_levels_in_order" CHECK (0 <= "reorder_rules"."min_quantity" and "reorder_rules"."min_quantity" <= "reorder_rules"."reorder_level"
        and "reorder_rules"."reorder_level" <= "reorder_rules"."max_quantity" and "reorder_rules"."max_quantity" > 0)
);
--> statement-breakpoint
ALTER TABLE "reorder_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reorder_rules" ADD CONSTRAINT "reorder_rules_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reorder_rules_organization_store_idx" ON "reorder_rules" USING btree ("organization_id","store_id");--> statement-breakpoint
CREATE POLICY "reorder_rules_tenant_isolation" ON "reorder_rules" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("reorder_rules"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("reorder_rules"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);