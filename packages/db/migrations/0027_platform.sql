CREATE TYPE "public"."plan" AS ENUM('trial', 'standard', 'enterprise');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'support_access_requested';--> statement-breakpoint
CREATE TABLE "platform_admins" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_admins" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "platform_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "platform_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "platform_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_access_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "support_access_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"organization_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "support_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"platform_user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"minutes" integer NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_member_id" uuid,
	"approved_at" timestamp with time zone,
	"declined_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "support_grants_minutes_range" CHECK ("support_grants"."minutes" between 15 and 480),
	CONSTRAINT "support_grants_one_decision" CHECK (not ("support_grants"."approved_at" is not null and "support_grants"."declined_at" is not null)),
	CONSTRAINT "support_grants_expiry_when_approved" CHECK (("support_grants"."approved_at" is null) = ("support_grants"."expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "support_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_members" ADD COLUMN "is_support" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "plan" "plan" DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "feature_flags" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "support_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_admins" ADD CONSTRAINT "platform_admins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_sessions" ADD CONSTRAINT "platform_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_access_log" ADD CONSTRAINT "support_access_log_grant_id_support_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."support_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_platform_user_id_users_id_fk" FOREIGN KEY ("platform_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_decided_by_fk" FOREIGN KEY ("organization_id","decided_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_access_log_grant_idx" ON "support_access_log" USING btree ("grant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "support_grants_organization_idx" ON "support_grants" USING btree ("organization_id","requested_at");--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_suspend_reason" CHECK (("organizations"."suspended_at" is null) = ("organizations"."suspend_reason" is null));--> statement-breakpoint
CREATE POLICY "support_access_log_tenant_read" ON "support_access_log" AS PERMISSIVE FOR SELECT TO "app_tenant" USING ("support_access_log"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "support_grants_tenant_read" ON "support_grants" AS PERMISSIVE FOR SELECT TO "app_tenant" USING ("support_grants"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "support_grants_tenant_decide" ON "support_grants" AS PERMISSIVE FOR UPDATE TO "app_tenant" USING ("support_grants"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("support_grants"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);