CREATE TYPE "public"."email_status" AS ENUM('pending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."notification_event" AS ENUM('transfer_awaiting_approval', 'transfer_awaiting_receipt', 'stock_count_awaiting_approval', 'low_stock');--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"event" "notification_event" NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"text_body" text NOT NULL,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "email_outbox_attempts_not_negative" CHECK ("email_outbox"."attempts" >= 0),
	CONSTRAINT "email_outbox_sent_when_sent" CHECK (("email_outbox"."status" = 'sent') = ("email_outbox"."sent_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "low_stock_alerts" (
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"alerted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "low_stock_alerts_store_id_variant_id_pk" PRIMARY KEY("store_id","variant_id")
);
--> statement-breakpoint
ALTER TABLE "low_stock_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"event" "notification_event" NOT NULL,
	"in_app" boolean NOT NULL,
	"email" boolean NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_member_id_event_pk" PRIMARY KEY("member_id","event")
);
--> statement-breakpoint
ALTER TABLE "notification_preferences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"event" "notification_event" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"link" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "low_stock_alerts" ADD CONSTRAINT "low_stock_alerts_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "low_stock_alerts" ADD CONSTRAINT "low_stock_alerts_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("next_attempt_at") WHERE "email_outbox"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "notifications_member_idx" ON "notifications" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_member_unread_idx" ON "notifications" USING btree ("member_id") WHERE "notifications"."read_at" is null;--> statement-breakpoint
CREATE POLICY "email_outbox_tenant_isolation" ON "email_outbox" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("email_outbox"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("email_outbox"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "low_stock_alerts_tenant_isolation" ON "low_stock_alerts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("low_stock_alerts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("low_stock_alerts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "notification_preferences_tenant_isolation" ON "notification_preferences" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("notification_preferences"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("notification_preferences"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "notifications_tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("notifications"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("notifications"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);