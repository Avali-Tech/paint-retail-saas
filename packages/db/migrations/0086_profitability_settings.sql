ALTER TABLE "loyalty_settings" ADD COLUMN "point_value_paise" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "cost_of_money_bps" integer DEFAULT 1200 NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_point_value" CHECK ("loyalty_settings"."point_value_paise" >= 0);--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_cost_of_money" CHECK ("sales_settings"."cost_of_money_bps" between 0 and 10000);