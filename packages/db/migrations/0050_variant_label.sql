ALTER TABLE "product_variants" DROP CONSTRAINT "product_variants_product_pack_unique";--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "label" text;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_product_pack_label_unique" ON "product_variants" USING btree ("product_id","pack_size","unit",lower(coalesce("label", '')));--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_label_format" CHECK ("product_variants"."label" = btrim("product_variants"."label") and char_length("product_variants"."label") between 1 and 40);--> statement-breakpoint

-- A variant's label names it ("2 inch", "Grit 120"), so changing it is audited like a rename.
DROP TRIGGER audit_product_variant_status ON product_variants;--> statement-breakpoint

CREATE TRIGGER audit_product_variant_status
AFTER UPDATE ON product_variants
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'is_active', 'label');
