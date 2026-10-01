CREATE TYPE "public"."activity_record_type" AS ENUM('party', 'lead', 'opportunity', 'project');--> statement-breakpoint
CREATE TYPE "public"."activity_type" AS ENUM('call', 'meeting', 'visit', 'whatsapp', 'email', 'follow_up', 'note');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'follow_up_due';--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_type" "activity_record_type" NOT NULL,
	"record_id" uuid NOT NULL,
	"store_id" uuid,
	"type" "activity_type" NOT NULL,
	"subject" text NOT NULL,
	"notes" text,
	"outcome" text,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"assigned_member_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activities_scheduled_or_done" CHECK ("activities"."due_at" is not null or "activities"."completed_at" is not null),
	CONSTRAINT "activities_done_or_cancelled" CHECK (not ("activities"."completed_at" is not null and "activities"."cancelled_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_assigned_member_fk" FOREIGN KEY ("organization_id","assigned_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_record_idx" ON "activities" USING btree ("organization_id","record_type","record_id");--> statement-breakpoint
CREATE INDEX "activities_assignee_open_idx" ON "activities" USING btree ("assigned_member_id","due_at") WHERE "activities"."completed_at" is null and "activities"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "activities_reminder_idx" ON "activities" USING btree ("due_at") WHERE "activities"."completed_at" is null and "activities"."cancelled_at" is null and "activities"."reminded_at" is null;--> statement-breakpoint
CREATE POLICY "activities_tenant_isolation" ON "activities" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("activities"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("activities"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);