CREATE TYPE "public"."credit_request_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."credit_risk" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."credit_status" AS ENUM('none', 'active', 'on_hold');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'credit_request_awaiting_approval';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'credit_request_decided';--> statement-breakpoint
CREATE TABLE "credit_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"status" "credit_status" DEFAULT 'none' NOT NULL,
	"limit_paise" bigint DEFAULT 0 NOT NULL,
	"credit_days" integer DEFAULT 0 NOT NULL,
	"risk" "credit_risk" DEFAULT 'low' NOT NULL,
	"manual_exposure_paise" bigint DEFAULT 0 NOT NULL,
	"overdue_days" integer DEFAULT 0 NOT NULL,
	"exposure_updated_at" timestamp with time zone,
	"exposure_updated_by_member_id" uuid,
	"hold_reason" text,
	"held_at" timestamp with time zone,
	"held_by_member_id" uuid,
	"notes" text,
	"approved_by_member_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_profiles_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "credit_profiles_party_unique" UNIQUE("party_id"),
	CONSTRAINT "credit_profiles_limit_not_negative" CHECK ("credit_profiles"."limit_paise" >= 0),
	CONSTRAINT "credit_profiles_days_range" CHECK ("credit_profiles"."credit_days" between 0 and 365),
	CONSTRAINT "credit_profiles_exposure_not_negative" CHECK ("credit_profiles"."manual_exposure_paise" >= 0),
	CONSTRAINT "credit_profiles_overdue_not_negative" CHECK ("credit_profiles"."overdue_days" >= 0),
	CONSTRAINT "credit_profiles_limit_when_enabled" CHECK ("credit_profiles"."status" = 'none' or "credit_profiles"."limit_paise" > 0),
	CONSTRAINT "credit_profiles_hold_reason" CHECK (("credit_profiles"."status" = 'on_hold') = ("credit_profiles"."hold_reason" is not null)),
	CONSTRAINT "credit_profiles_hold_complete" CHECK (("credit_profiles"."hold_reason" is null) = ("credit_profiles"."held_at" is null) and ("credit_profiles"."held_at" is null) = ("credit_profiles"."held_by_member_id" is null))
);
--> statement-breakpoint
ALTER TABLE "credit_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "credit_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"party_id" uuid NOT NULL,
	"limit_paise" bigint NOT NULL,
	"credit_days" integer NOT NULL,
	"previous_limit_paise" bigint NOT NULL,
	"previous_credit_days" integer NOT NULL,
	"note" text,
	"status" "credit_request_status" DEFAULT 'pending' NOT NULL,
	"requested_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_member_id" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "credit_requests_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "credit_requests_limit_positive" CHECK ("credit_requests"."limit_paise" > 0),
	CONSTRAINT "credit_requests_days_range" CHECK ("credit_requests"."credit_days" between 0 and 365),
	CONSTRAINT "credit_requests_decided_when_decided" CHECK (("credit_requests"."status" = 'pending') = ("credit_requests"."decided_at" is null and "credit_requests"."decided_by_member_id" is null)),
	CONSTRAINT "credit_requests_rejection_note" CHECK ("credit_requests"."status" <> 'rejected' or "credit_requests"."decision_note" is not null)
);
--> statement-breakpoint
ALTER TABLE "credit_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "credit_rules" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"normal_up_to_percent" integer DEFAULT 80 NOT NULL,
	"manager_up_to_percent" integer DEFAULT 100 NOT NULL,
	"hold_after_overdue_days" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_rules_percent_order" CHECK (0 <= "credit_rules"."normal_up_to_percent" and "credit_rules"."normal_up_to_percent" <= "credit_rules"."manager_up_to_percent" and "credit_rules"."manager_up_to_percent" <= 1000),
	CONSTRAINT "credit_rules_hold_days_positive" CHECK ("credit_rules"."hold_after_overdue_days" >= 1)
);
--> statement-breakpoint
ALTER TABLE "credit_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_exposure_updated_by_fk" FOREIGN KEY ("organization_id","exposure_updated_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_held_by_fk" FOREIGN KEY ("organization_id","held_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_profiles" ADD CONSTRAINT "credit_profiles_approved_by_fk" FOREIGN KEY ("organization_id","approved_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_requests" ADD CONSTRAINT "credit_requests_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_requests" ADD CONSTRAINT "credit_requests_requested_by_fk" FOREIGN KEY ("organization_id","requested_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_requests" ADD CONSTRAINT "credit_requests_decided_by_fk" FOREIGN KEY ("organization_id","decided_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_rules" ADD CONSTRAINT "credit_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_profiles_status_idx" ON "credit_profiles" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_requests_one_pending_per_party" ON "credit_requests" USING btree ("party_id") WHERE "credit_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "credit_requests_status_idx" ON "credit_requests" USING btree ("organization_id","status","created_at");--> statement-breakpoint
CREATE POLICY "credit_profiles_tenant_isolation" ON "credit_profiles" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("credit_profiles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("credit_profiles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "credit_requests_tenant_isolation" ON "credit_requests" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("credit_requests"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("credit_requests"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "credit_rules_tenant_isolation" ON "credit_rules" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("credit_rules"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("credit_rules"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);