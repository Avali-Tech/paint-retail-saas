CREATE TYPE "public"."credit_approval_kind" AS ENUM('sale', 'release');--> statement-breakpoint
CREATE TYPE "public"."credit_approval_level" AS ENUM('manager', 'owner');--> statement-breakpoint
CREATE TYPE "public"."credit_approval_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'used');--> statement-breakpoint
CREATE TYPE "public"."credit_hold_kind" AS ENUM('manual', 'auto');--> statement-breakpoint
CREATE TYPE "public"."site_account_status" AS ENUM('active', 'on_hold', 'closed');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'credit_approval_requested';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'credit_approval_decided';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'credit_hold_applied';--> statement-breakpoint
CREATE TABLE "credit_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"kind" "credit_approval_kind" NOT NULL,
	"party_id" uuid NOT NULL,
	"project_id" uuid,
	"store_id" uuid,
	"sales_order_id" uuid,
	"tax_document_id" uuid,
	"level" "credit_approval_level",
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"check" jsonb,
	"reason" text NOT NULL,
	"status" "credit_approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_member_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"waive_overdue_until" date,
	"used_at" timestamp with time zone,
	CONSTRAINT "credit_approvals_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "credit_approvals_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "credit_approvals_number_format" CHECK ("credit_approvals"."number" ~ '^AP-[0-9]{6,}$'),
	CONSTRAINT "credit_approvals_subject" CHECK (case when "credit_approvals"."kind" = 'sale'
        then num_nonnulls("credit_approvals"."sales_order_id", "credit_approvals"."tax_document_id") = 1
          and "credit_approvals"."level" is not null and "credit_approvals"."check" is not null and "credit_approvals"."store_id" is not null
          and "credit_approvals"."waive_overdue_until" is null
        else "credit_approvals"."sales_order_id" is null and "credit_approvals"."tax_document_id" is null
          and "credit_approvals"."level" is null and "credit_approvals"."project_id" is null and "credit_approvals"."amount_paise" = 0
      end),
	CONSTRAINT "credit_approvals_amount_not_negative" CHECK ("credit_approvals"."amount_paise" >= 0),
	CONSTRAINT "credit_approvals_decided" CHECK (("credit_approvals"."status" = 'pending') = ("credit_approvals"."decided_at" is null)
        and ("credit_approvals"."decided_at" is null) = ("credit_approvals"."decided_by_member_id" is null)),
	CONSTRAINT "credit_approvals_rejection_reason" CHECK ("credit_approvals"."status" <> 'rejected' or "credit_approvals"."decision_reason" is not null),
	CONSTRAINT "credit_approvals_used" CHECK (("credit_approvals"."status" = 'used') = ("credit_approvals"."used_at" is not null)),
	CONSTRAINT "credit_approvals_text_lengths" CHECK (char_length("credit_approvals"."reason") between 1 and 1000 and char_length("credit_approvals"."decision_reason") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "credit_approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "credit_hold_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_on" date DEFAULT (now() at time zone 'Asia/Kolkata')::date NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"held_count" integer NOT NULL,
	CONSTRAINT "credit_hold_runs_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "credit_hold_runs_daily_unique" UNIQUE("organization_id","run_on"),
	CONSTRAINT "credit_hold_runs_held_count" CHECK ("credit_hold_runs"."held_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "credit_hold_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "site_credit_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"limit_paise" bigint NOT NULL,
	"status" "site_account_status" DEFAULT 'active' NOT NULL,
	"hold_reason" text,
	"held_at" timestamp with time zone,
	"held_by_member_id" uuid,
	"notes" text,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_credit_accounts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "site_credit_accounts_party_project_unique" UNIQUE("organization_id","party_id","project_id"),
	CONSTRAINT "site_credit_accounts_limit_positive" CHECK ("site_credit_accounts"."limit_paise" > 0),
	CONSTRAINT "site_credit_accounts_hold" CHECK (("site_credit_accounts"."status" = 'on_hold') = ("site_credit_accounts"."hold_reason" is not null)
        and ("site_credit_accounts"."hold_reason" is null) = ("site_credit_accounts"."held_at" is null)
        and ("site_credit_accounts"."held_at" is null) = ("site_credit_accounts"."held_by_member_id" is null)),
	CONSTRAINT "site_credit_accounts_text_lengths" CHECK (char_length("site_credit_accounts"."hold_reason") <= 500 and char_length("site_credit_accounts"."notes") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "site_credit_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_profiles" DROP CONSTRAINT "credit_profiles_hold_complete";--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD COLUMN "hold_kind" "credit_hold_kind";--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD COLUMN "overdue_waived_until" date;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "credit_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD COLUMN "credit_check" jsonb;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD COLUMN "credit_approval_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_approvals" ADD CONSTRAINT "credit_approvals_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_approvals" ADD CONSTRAINT "credit_approvals_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_approvals" ADD CONSTRAINT "credit_approvals_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_approvals" ADD CONSTRAINT "credit_approvals_sales_order_fk" FOREIGN KEY ("organization_id","sales_order_id") REFERENCES "public"."sales_orders"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_approvals" ADD CONSTRAINT "credit_approvals_tax_document_fk" FOREIGN KEY ("organization_id","tax_document_id") REFERENCES "public"."tax_documents"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_approvals" ADD CONSTRAINT "credit_approvals_requested_by_fk" FOREIGN KEY ("organization_id","requested_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_approvals" ADD CONSTRAINT "credit_approvals_decided_by_fk" FOREIGN KEY ("organization_id","decided_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_hold_runs" ADD CONSTRAINT "credit_hold_runs_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_credit_accounts" ADD CONSTRAINT "site_credit_accounts_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_credit_accounts" ADD CONSTRAINT "site_credit_accounts_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_credit_accounts" ADD CONSTRAINT "site_credit_accounts_held_by_fk" FOREIGN KEY ("organization_id","held_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_credit_accounts" ADD CONSTRAINT "site_credit_accounts_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "credit_approvals_one_pending_per_order" ON "credit_approvals" USING btree ("sales_order_id") WHERE "credit_approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_approvals_one_pending_per_invoice" ON "credit_approvals" USING btree ("tax_document_id") WHERE "credit_approvals"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "credit_approvals_one_pending_release" ON "credit_approvals" USING btree ("party_id") WHERE "credit_approvals"."status" = 'pending' and "credit_approvals"."kind" = 'release';--> statement-breakpoint
CREATE INDEX "credit_approvals_status_idx" ON "credit_approvals" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE INDEX "credit_approvals_party_idx" ON "credit_approvals" USING btree ("organization_id","party_id");--> statement-breakpoint
CREATE INDEX "site_credit_accounts_project_idx" ON "site_credit_accounts" USING btree ("organization_id","project_id");--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_credit_approval_fk" FOREIGN KEY ("organization_id","credit_approval_id") REFERENCES "public"."credit_approvals"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_documents" ADD CONSTRAINT "tax_documents_credit_approval_fk" FOREIGN KEY ("organization_id","credit_approval_id") REFERENCES "public"."credit_approvals"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Every hold so far was put on by a person (P1-M25): mark it so before the new rule applies.
UPDATE "credit_profiles" SET "hold_kind" = 'manual' WHERE "hold_reason" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_hold_complete" CHECK (("credit_profiles"."hold_reason" is null) = ("credit_profiles"."held_at" is null) and ("credit_profiles"."held_at" is null) = ("credit_profiles"."hold_kind" is null) and ("credit_profiles"."held_by_member_id" is not null) = ("credit_profiles"."hold_kind" is not distinct from 'manual'));--> statement-breakpoint
CREATE POLICY "credit_approvals_tenant_isolation" ON "credit_approvals" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("credit_approvals"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("credit_approvals"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "credit_hold_runs_tenant_isolation" ON "credit_hold_runs" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("credit_hold_runs"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("credit_hold_runs"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "site_credit_accounts_tenant_isolation" ON "site_credit_accounts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("site_credit_accounts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("site_credit_accounts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);