CREATE TYPE "public"."loyalty_entry_kind" AS ENUM('purchase', 'award', 'campaign', 'redeem', 'adjust', 'expire');--> statement-breakpoint
CREATE TYPE "public"."loyalty_status" AS ENUM('active', 'closed');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'loyalty_tier_reached';--> statement-breakpoint
CREATE TABLE "loyalty_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"status" "loyalty_status" DEFAULT 'active' NOT NULL,
	"assigned_member_id" uuid,
	"expiry_checked_on" date,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_accounts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "loyalty_accounts_party_unique" UNIQUE("party_id")
);
--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" "loyalty_entry_kind" NOT NULL,
	"points" integer NOT NULL,
	"manual_purchase_paise" bigint,
	"reference" text,
	"note" text,
	"expires_on" date,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "loyalty_ledger_points_sign" CHECK (case "loyalty_ledger"."kind"
        when 'redeem' then "loyalty_ledger"."points" < 0
        when 'expire' then "loyalty_ledger"."points" < 0
        when 'adjust' then "loyalty_ledger"."points" <> 0
        else "loyalty_ledger"."points" > 0 end),
	CONSTRAINT "loyalty_ledger_purchase" CHECK (("loyalty_ledger"."kind" = 'purchase') = ("loyalty_ledger"."manual_purchase_paise" is not null) and ("loyalty_ledger"."manual_purchase_paise" is null or "loyalty_ledger"."manual_purchase_paise" > 0)),
	CONSTRAINT "loyalty_ledger_reference" CHECK ("loyalty_ledger"."kind" not in ('purchase', 'campaign') or "loyalty_ledger"."reference" is not null),
	CONSTRAINT "loyalty_ledger_adjust_reason" CHECK ("loyalty_ledger"."kind" <> 'adjust' or "loyalty_ledger"."note" is not null),
	CONSTRAINT "loyalty_ledger_expiry_on_lots" CHECK ("loyalty_ledger"."expires_on" is null or "loyalty_ledger"."points" > 0),
	CONSTRAINT "loyalty_ledger_system_expiry" CHECK (("loyalty_ledger"."kind" = 'expire') = ("loyalty_ledger"."created_by_member_id" is null))
);
--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "loyalty_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"earn_points" integer DEFAULT 1 NOT NULL,
	"earn_per_paise" bigint DEFAULT 10000 NOT NULL,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expiry_days" integer,
	"min_redemption_points" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_settings_earn_positive" CHECK ("loyalty_settings"."earn_points" > 0 and "loyalty_settings"."earn_per_paise" > 0),
	CONSTRAINT "loyalty_settings_expiry_positive" CHECK ("loyalty_settings"."expiry_days" > 0),
	CONSTRAINT "loyalty_settings_min_redemption" CHECK ("loyalty_settings"."min_redemption_points" >= 0),
	CONSTRAINT "loyalty_settings_tiers_array" CHECK (jsonb_typeof("loyalty_settings"."tiers") = 'array')
);
--> statement-breakpoint
ALTER TABLE "loyalty_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_assigned_member_fk" FOREIGN KEY ("organization_id","assigned_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_accounts" ADD CONSTRAINT "loyalty_accounts_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_account_fk" FOREIGN KEY ("organization_id","account_id") REFERENCES "public"."loyalty_accounts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_ledger" ADD CONSTRAINT "loyalty_ledger_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_settings" ADD CONSTRAINT "loyalty_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_ledger_account_idx" ON "loyalty_ledger" USING btree ("organization_id","account_id","created_at");--> statement-breakpoint
CREATE INDEX "loyalty_ledger_expiry_idx" ON "loyalty_ledger" USING btree ("expires_on") WHERE "loyalty_ledger"."expires_on" is not null;--> statement-breakpoint
CREATE POLICY "loyalty_accounts_tenant_isolation" ON "loyalty_accounts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("loyalty_accounts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("loyalty_accounts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "loyalty_ledger_tenant_isolation" ON "loyalty_ledger" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("loyalty_ledger"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("loyalty_ledger"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "loyalty_settings_tenant_isolation" ON "loyalty_settings" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("loyalty_settings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("loyalty_settings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);