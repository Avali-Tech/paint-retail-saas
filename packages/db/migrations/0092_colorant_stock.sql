ALTER TYPE "public"."notification_event" ADD VALUE 'colorant_short';--> statement-breakpoint
ALTER TYPE "public"."product_type" ADD VALUE 'colorant';--> statement-breakpoint
ALTER TYPE "public"."stock_movement_type" ADD VALUE 'tint_use';--> statement-breakpoint
ALTER TABLE "stock_ledger" DROP CONSTRAINT "stock_ledger_quantity_sign";--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "density_g_per_ml" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "tint_shot_ml" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "tint_y_ml" numeric(7, 4);--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_density_range" CHECK ("product_variants"."density_g_per_ml" > 0 and "product_variants"."density_g_per_ml" <= 25);--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_tint_units_positive" CHECK ("sales_settings"."tint_shot_ml" > 0 and "sales_settings"."tint_y_ml" > 0);--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_quantity_sign" CHECK (case
        when "stock_ledger"."movement_type" in ('opening', 'purchase_receipt', 'transfer_in', 'sale_return') then "stock_ledger"."quantity" > 0
        when "stock_ledger"."movement_type"::text in ('purchase_return', 'transfer_out', 'sale', 'damage', 'tint_use') then "stock_ledger"."quantity" < 0
        else "stock_ledger"."quantity" <> 0
      end);