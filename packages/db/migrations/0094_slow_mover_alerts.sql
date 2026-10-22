ALTER TYPE "public"."notification_event" ADD VALUE 'slow_movers';--> statement-breakpoint
CREATE TABLE "slow_mover_alerts" (
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"alerted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slow_mover_alerts_store_id_variant_id_pk" PRIMARY KEY("store_id","variant_id")
);
--> statement-breakpoint
ALTER TABLE "slow_mover_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "slow_mover_alert_days" integer DEFAULT 90;--> statement-breakpoint
ALTER TABLE "slow_mover_alerts" ADD CONSTRAINT "slow_mover_alerts_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slow_mover_alerts" ADD CONSTRAINT "slow_mover_alerts_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_slow_mover_days" CHECK ("sales_settings"."slow_mover_alert_days" in (45, 90, 180, 365));--> statement-breakpoint
CREATE POLICY "slow_mover_alerts_tenant_isolation" ON "slow_mover_alerts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("slow_mover_alerts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("slow_mover_alerts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);