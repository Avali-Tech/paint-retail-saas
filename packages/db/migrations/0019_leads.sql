CREATE TYPE "public"."lead_source" AS ENUM('walk_in', 'phone_call', 'referral', 'architect', 'contractor', 'painter', 'website', 'social_media', 'exhibition', 'other');--> statement-breakpoint
CREATE TYPE "public"."lead_stage" AS ENUM('new', 'contacted', 'qualified', 'opportunity', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."opportunity_stage" AS ENUM('discovery', 'proposal', 'negotiation', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"title" text NOT NULL,
	"requirement" text,
	"source" "lead_source" NOT NULL,
	"referred_by_party_id" uuid,
	"estimated_value_paise" bigint,
	"expected_order_date" date,
	"assigned_member_id" uuid,
	"stage" "lead_stage" DEFAULT 'new' NOT NULL,
	"lost_reason" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "leads_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "leads_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "leads_value_not_negative" CHECK ("leads"."estimated_value_paise" >= 0),
	CONSTRAINT "leads_lost_reason" CHECK (("leads"."stage" = 'lost') = ("leads"."lost_reason" is not null)),
	CONSTRAINT "leads_closed_when_closed" CHECK (("leads"."stage" in ('won', 'lost')) = ("leads"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"lead_id" uuid,
	"title" text NOT NULL,
	"expected_value_paise" bigint NOT NULL,
	"expected_quantity" numeric(12, 3),
	"expected_order_date" date,
	"category_id" uuid,
	"salesperson_member_id" uuid,
	"probability" integer NOT NULL,
	"stage" "opportunity_stage" DEFAULT 'discovery' NOT NULL,
	"lost_reason" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "opportunities_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "opportunities_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "opportunities_lead_unique" UNIQUE("lead_id"),
	CONSTRAINT "opportunities_value_not_negative" CHECK ("opportunities"."expected_value_paise" >= 0),
	CONSTRAINT "opportunities_quantity_positive" CHECK ("opportunities"."expected_quantity" > 0),
	CONSTRAINT "opportunities_probability_range" CHECK ("opportunities"."probability" between 0 and 100),
	CONSTRAINT "opportunities_lost_reason" CHECK (("opportunities"."stage" = 'lost') = ("opportunities"."lost_reason" is not null)),
	CONSTRAINT "opportunities_closed_when_closed" CHECK (("opportunities"."stage" in ('won', 'lost')) = ("opportunities"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "opportunities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_referred_by_fk" FOREIGN KEY ("organization_id","referred_by_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_member_fk" FOREIGN KEY ("organization_id","assigned_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_lead_fk" FOREIGN KEY ("organization_id","lead_id") REFERENCES "public"."leads"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_salesperson_fk" FOREIGN KEY ("organization_id","salesperson_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leads_store_stage_idx" ON "leads" USING btree ("organization_id","store_id","stage");--> statement-breakpoint
CREATE INDEX "leads_assigned_idx" ON "leads" USING btree ("assigned_member_id");--> statement-breakpoint
CREATE INDEX "leads_party_idx" ON "leads" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "opportunities_store_stage_idx" ON "opportunities" USING btree ("organization_id","store_id","stage");--> statement-breakpoint
CREATE INDEX "opportunities_salesperson_idx" ON "opportunities" USING btree ("salesperson_member_id");--> statement-breakpoint
CREATE INDEX "opportunities_party_idx" ON "opportunities" USING btree ("party_id");--> statement-breakpoint
CREATE POLICY "leads_tenant_isolation" ON "leads" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("leads"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("leads"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "opportunities_tenant_isolation" ON "opportunities" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("opportunities"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("opportunities"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);