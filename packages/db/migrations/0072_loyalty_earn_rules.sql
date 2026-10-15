CREATE TYPE "public"."loyalty_earn_basis" AS ENUM('value', 'litre');--> statement-breakpoint
ALTER TYPE "public"."loyalty_entry_kind" ADD VALUE 'influencer';--> statement-breakpoint
CREATE TABLE "loyalty_earn_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"basis" "loyalty_earn_basis" NOT NULL,
	"points" integer NOT NULL,
	"per_paise" bigint,
	"per_millilitres" integer,
	"brand_id" uuid,
	"multiplier_bps" integer DEFAULT 10000 NOT NULL,
	"valid_from" date,
	"valid_until" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_earn_rules_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "loyalty_earn_rules_name" CHECK ("loyalty_earn_rules"."name" = btrim("loyalty_earn_rules"."name") and char_length("loyalty_earn_rules"."name") between 1 and 100),
	CONSTRAINT "loyalty_earn_rules_points_positive" CHECK ("loyalty_earn_rules"."points" > 0),
	CONSTRAINT "loyalty_earn_rules_basis" CHECK (("loyalty_earn_rules"."basis" = 'value') = ("loyalty_earn_rules"."per_paise" is not null)
        and ("loyalty_earn_rules"."basis" = 'litre') = ("loyalty_earn_rules"."per_millilitres" is not null)
        and ("loyalty_earn_rules"."per_paise" is null or "loyalty_earn_rules"."per_paise" > 0)
        and ("loyalty_earn_rules"."per_millilitres" is null or "loyalty_earn_rules"."per_millilitres" > 0)),
	CONSTRAINT "loyalty_earn_rules_multiplier" CHECK ("loyalty_earn_rules"."multiplier_bps" between 1 and 1000000),
	CONSTRAINT "loyalty_earn_rules_period" CHECK ("loyalty_earn_rules"."valid_from" is null or "loyalty_earn_rules"."valid_until" is null or "loyalty_earn_rules"."valid_from" <= "loyalty_earn_rules"."valid_until")
);
--> statement-breakpoint
ALTER TABLE "loyalty_earn_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" DROP CONSTRAINT "loyalty_ledger_purchase";--> statement-breakpoint
ALTER TABLE "loyalty_ledger" DROP CONSTRAINT "loyalty_ledger_reference";--> statement-breakpoint
ALTER TABLE "loyalty_earn_rules" ADD CONSTRAINT "loyalty_earn_rules_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_earn_rules" ADD CONSTRAINT "loyalty_earn_rules_brand_fk" FOREIGN KEY ("organization_id","brand_id") REFERENCES "public"."brands"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_earn_rules" ADD CONSTRAINT "loyalty_earn_rules_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_earn_rules_organization_name_unique" ON "loyalty_earn_rules" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE INDEX "loyalty_earn_rules_brand_idx" ON "loyalty_earn_rules" USING btree ("organization_id","brand_id");--> statement-breakpoint
-- Hand-written: an index predicate needs an immutable function, and the value
-- 'influencer' cannot be cast to in this transaction (it was added in it), so
-- the kind is compared as text. Enum labels are never renamed here.
CREATE FUNCTION loyalty_is_influencer(kind loyalty_entry_kind) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT kind::text = 'influencer' $$;--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_ledger_invoice_influencer_unique" ON "loyalty_ledger" USING btree ("tax_document_id") WHERE loyalty_is_influencer("loyalty_ledger"."kind");--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_influencer" CHECK ("loyalty_ledger"."kind"::text <> 'influencer' or "loyalty_ledger"."tax_document_id" is not null);--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_purchase" CHECK (("loyalty_ledger"."kind" <> 'purchase' or num_nonnulls("loyalty_ledger"."manual_purchase_paise", "loyalty_ledger"."tax_document_id") = 1)
        and ("loyalty_ledger"."manual_purchase_paise" is null or ("loyalty_ledger"."kind" = 'purchase' and "loyalty_ledger"."manual_purchase_paise" > 0))
        and ("loyalty_ledger"."tax_document_id" is null or "loyalty_ledger"."kind"::text in ('purchase', 'adjust', 'influencer')));--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_reference" CHECK ("loyalty_ledger"."kind"::text not in ('purchase', 'campaign', 'influencer') or "loyalty_ledger"."reference" is not null);--> statement-breakpoint
CREATE POLICY "loyalty_earn_rules_tenant_isolation" ON "loyalty_earn_rules" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("loyalty_earn_rules"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("loyalty_earn_rules"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);