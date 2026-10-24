CREATE TYPE "public"."mistint_status" AS ENUM('available', 'sold', 'written_off');--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'mistint';--> statement-breakpoint
CREATE TABLE "mistinted_cans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"shade_code" text NOT NULL,
	"shade_name" text,
	"intended_shade" text,
	"reason" text NOT NULL,
	"cost_paise" bigint,
	"status" "mistint_status" DEFAULT 'available' NOT NULL,
	"sold_taxable_paise" bigint,
	"resolved_at" timestamp with time zone,
	"resolved_by_member_id" uuid,
	"note" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mistinted_cans_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "mistinted_cans_quantity_positive" CHECK ("mistinted_cans"."quantity" > 0),
	CONSTRAINT "mistinted_cans_cost" CHECK ("mistinted_cans"."cost_paise" >= 0 and "mistinted_cans"."sold_taxable_paise" >= 0),
	CONSTRAINT "mistinted_cans_resolution" CHECK (("mistinted_cans"."status"::text = 'available') = ("mistinted_cans"."resolved_at" is null)
        and ("mistinted_cans"."sold_taxable_paise" is null or "mistinted_cans"."status"::text = 'sold'))
);
--> statement-breakpoint
ALTER TABLE "mistinted_cans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD COLUMN "mistint_can_id" uuid;--> statement-breakpoint
ALTER TABLE "mistinted_cans" ADD CONSTRAINT "mistinted_cans_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistinted_cans" ADD CONSTRAINT "mistinted_cans_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mistinted_cans_status_idx" ON "mistinted_cans" USING btree ("organization_id","status","created_at");--> statement-breakpoint
ALTER TABLE "tax_document_lines" ADD CONSTRAINT "tax_document_lines_mistint_can_fk" FOREIGN KEY ("organization_id","mistint_can_id") REFERENCES "public"."mistinted_cans"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "mistinted_cans_tenant_isolation" ON "mistinted_cans" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("mistinted_cans"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("mistinted_cans"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE TRIGGER audit_mistinted_cans
AFTER INSERT OR UPDATE ON mistinted_cans
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'status', 'cost_paise', 'sold_taxable_paise', 'note');
