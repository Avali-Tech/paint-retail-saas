CREATE TYPE "public"."reconciliation_kind" AS ENUM('stock_on_hand', 'stock_reserved', 'party_balance', 'allocation');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_trigger" AS ENUM('scheduled', 'manual');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'reconciliation_mismatch';--> statement-breakpoint
CREATE TABLE "go_live_openings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"overdue_since" date,
	"imported_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "go_live_openings_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "go_live_openings_party_unique" UNIQUE("organization_id","party_id"),
	CONSTRAINT "go_live_openings_amount_not_negative" CHECK ("go_live_openings"."amount_paise" >= 0),
	CONSTRAINT "go_live_openings_overdue_needs_amount" CHECK ("go_live_openings"."overdue_since" is null or "go_live_openings"."amount_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "go_live_openings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reconciliation_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "reconciliation_kind" NOT NULL,
	"store_id" uuid,
	"variant_id" uuid,
	"party_id" uuid,
	"recorded" numeric(20, 3) NOT NULL,
	"expected" numeric(20, 3) NOT NULL,
	"advance_paise" bigint,
	"unallocated_paise" bigint,
	CONSTRAINT "reconciliation_findings_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "reconciliation_findings_subject" CHECK (case
        when "reconciliation_findings"."kind" in ('stock_on_hand', 'stock_reserved')
          then "reconciliation_findings"."store_id" is not null and "reconciliation_findings"."variant_id" is not null and "reconciliation_findings"."party_id" is null
        else "reconciliation_findings"."party_id" is not null and "reconciliation_findings"."store_id" is null and "reconciliation_findings"."variant_id" is null
      end),
	CONSTRAINT "reconciliation_findings_allocation_figures" CHECK (("reconciliation_findings"."kind" = 'allocation') = ("reconciliation_findings"."advance_paise" is not null)
        and ("reconciliation_findings"."advance_paise" is null) = ("reconciliation_findings"."unallocated_paise" is null))
);
--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"trigger" "reconciliation_trigger" NOT NULL,
	"run_on" date DEFAULT (now() at time zone 'Asia/Kolkata')::date NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_member_id" uuid,
	"finding_count" integer NOT NULL,
	CONSTRAINT "reconciliation_runs_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "reconciliation_runs_requested_by" CHECK (("reconciliation_runs"."trigger" = 'manual') = ("reconciliation_runs"."requested_by_member_id" is not null)),
	CONSTRAINT "reconciliation_runs_finding_count" CHECK ("reconciliation_runs"."finding_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "go_live_openings" ADD CONSTRAINT "go_live_openings_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "go_live_openings" ADD CONSTRAINT "go_live_openings_imported_by_fk" FOREIGN KEY ("organization_id","imported_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_run_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."reconciliation_runs"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_findings" ADD CONSTRAINT "reconciliation_findings_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_requested_by_fk" FOREIGN KEY ("organization_id","requested_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_findings_run_idx" ON "reconciliation_findings" USING btree ("organization_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_scheduled_unique" ON "reconciliation_runs" USING btree ("organization_id","run_on") WHERE "reconciliation_runs"."trigger" = 'scheduled';--> statement-breakpoint
CREATE INDEX "reconciliation_runs_latest_idx" ON "reconciliation_runs" USING btree ("organization_id","ran_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "register_sessions_organization_opened_idx" ON "register_sessions" USING btree ("organization_id","opened_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "tax_documents_store_created_idx" ON "tax_documents" USING btree ("organization_id","store_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE POLICY "go_live_openings_tenant_isolation" ON "go_live_openings" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("go_live_openings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("go_live_openings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "reconciliation_findings_tenant_isolation" ON "reconciliation_findings" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("reconciliation_findings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("reconciliation_findings"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "reconciliation_runs_tenant_isolation" ON "reconciliation_runs" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("reconciliation_runs"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("reconciliation_runs"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);