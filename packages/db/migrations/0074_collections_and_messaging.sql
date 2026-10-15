CREATE TYPE "public"."consent_method" AS ENUM('counter_with_notice', 'signed_form', 'web_form', 'whatsapp_reply');--> statement-breakpoint
CREATE TYPE "public"."consent_state" AS ENUM('granted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."message_channel" AS ENUM('whatsapp', 'sms', 'email');--> statement-breakpoint
CREATE TYPE "public"."message_language" AS ENUM('en', 'hi', 'te');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('queued', 'sent', 'delivered', 'read', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."message_template_key" AS ENUM('invoice_issued', 'receipt_issued', 'statement_ready', 'payment_reminder_due', 'payment_reminder_overdue', 'promise_confirmed', 'order_ready', 'points_earned');--> statement-breakpoint
CREATE TYPE "public"."promise_status" AS ENUM('open', 'kept', 'broken', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'promise_to_pay';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'promise_broken';--> statement-breakpoint
CREATE TABLE "collection_escalations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"promise_id" uuid NOT NULL,
	"raised_on" date DEFAULT (now() at time zone 'Asia/Kolkata')::date NOT NULL,
	"notified_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_by_member_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"acknowledge_note" text,
	CONSTRAINT "collection_escalations_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "collection_escalations_promise_unique" UNIQUE("promise_id"),
	CONSTRAINT "collection_escalations_notified_count" CHECK ("collection_escalations"."notified_count" >= 0),
	CONSTRAINT "collection_escalations_acknowledged" CHECK (("collection_escalations"."acknowledged_at" is null) = ("collection_escalations"."acknowledged_by_member_id" is null)
        and ("collection_escalations"."acknowledge_note" is null or "collection_escalations"."acknowledged_at" is not null)
        and char_length("collection_escalations"."acknowledge_note") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "collection_escalations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "collection_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_on" date DEFAULT (now() at time zone 'Asia/Kolkata')::date NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kept_count" integer NOT NULL,
	"broken_count" integer NOT NULL,
	"reminders_queued" integer NOT NULL,
	CONSTRAINT "collection_runs_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "collection_runs_daily_unique" UNIQUE("organization_id","run_on"),
	CONSTRAINT "collection_runs_counts" CHECK ("collection_runs"."kept_count" >= 0 and "collection_runs"."broken_count" >= 0 and "collection_runs"."reminders_queued" >= 0)
);
--> statement-breakpoint
ALTER TABLE "collection_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"template_key" "message_template_key" NOT NULL,
	"language" "message_language" NOT NULL,
	"to_address" text NOT NULL,
	"variables" jsonb NOT NULL,
	"body" text NOT NULL,
	"reference_type" text,
	"reference_id" uuid,
	"dedupe_key" text,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"skip_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"provider" text,
	"provider_ref" text,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "message_outbox_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "message_outbox_dedupe_unique" UNIQUE("organization_id","dedupe_key"),
	CONSTRAINT "message_outbox_attempts_not_negative" CHECK ("message_outbox"."attempts" >= 0),
	CONSTRAINT "message_outbox_variables_object" CHECK (jsonb_typeof("message_outbox"."variables") = 'object'),
	CONSTRAINT "message_outbox_states" CHECK (("message_outbox"."status" in ('sent', 'delivered', 'read')) = ("message_outbox"."sent_at" is not null)
        and ("message_outbox"."status" in ('sent', 'delivered', 'read')) = ("message_outbox"."provider_ref" is not null)
        and ("message_outbox"."status" = 'skipped') = ("message_outbox"."skip_reason" is not null)
        and ("message_outbox"."reference_type" is null) = ("message_outbox"."reference_id" is null)),
	CONSTRAINT "message_outbox_text_lengths" CHECK (char_length("message_outbox"."body") between 1 and 2000 and char_length("message_outbox"."to_address") <= 320
        and char_length("message_outbox"."skip_reason") <= 200 and char_length("message_outbox"."last_error") <= 500
        and char_length("message_outbox"."dedupe_key") <= 200 and char_length("message_outbox"."reference_type") <= 40)
);
--> statement-breakpoint
ALTER TABLE "message_outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" "message_template_key" NOT NULL,
	"channel" "message_channel" NOT NULL,
	"language" "message_language" NOT NULL,
	"body" text NOT NULL,
	"provider_template_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "message_templates_key_unique" UNIQUE("organization_id","key","channel","language"),
	CONSTRAINT "message_templates_body" CHECK (char_length("message_templates"."body") between 1 and 1000),
	CONSTRAINT "message_templates_provider_name" CHECK ("message_templates"."provider_template_name" ~ '^[a-z0-9_]{1,200}$')
);
--> statement-breakpoint
ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messaging_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"channel" "message_channel" NOT NULL,
	"address" text NOT NULL,
	"state" "consent_state" NOT NULL,
	"method" "consent_method" NOT NULL,
	"notice_version" text NOT NULL,
	"language" "message_language" NOT NULL,
	"recorded_by_member_id" uuid,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "messaging_consents_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "messaging_consents_address" CHECK (case "messaging_consents"."channel" when 'email' then "messaging_consents"."address" = lower("messaging_consents"."address") and "messaging_consents"."address" ~ '^[^@[:space:]]+@[^@[:space:]]+$'
        else "messaging_consents"."address" ~ '^\+[1-9][0-9]{7,14}$' end),
	CONSTRAINT "messaging_consents_member" CHECK ("messaging_consents"."recorded_by_member_id" is not null or "messaging_consents"."method" = 'whatsapp_reply'),
	CONSTRAINT "messaging_consents_notice_version" CHECK (char_length("messaging_consents"."notice_version") between 1 and 40)
);
--> statement-breakpoint
ALTER TABLE "messaging_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promises_to_pay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"promised_on" date NOT NULL,
	"made_on" date DEFAULT (now() at time zone 'Asia/Kolkata')::date NOT NULL,
	"status" "promise_status" DEFAULT 'open' NOT NULL,
	"note" text,
	"activity_id" uuid,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_paise" bigint,
	"closed_at" timestamp with time zone,
	"closed_by_member_id" uuid,
	"cancel_reason" text,
	CONSTRAINT "promises_to_pay_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "promises_to_pay_amount_positive" CHECK ("promises_to_pay"."amount_paise" > 0),
	CONSTRAINT "promises_to_pay_dates" CHECK ("promises_to_pay"."promised_on" >= "promises_to_pay"."made_on"),
	CONSTRAINT "promises_to_pay_closed" CHECK (("promises_to_pay"."status" = 'open') = ("promises_to_pay"."closed_at" is null)
        and ("promises_to_pay"."status" in ('kept', 'broken')) = ("promises_to_pay"."paid_paise" is not null)
        and ("promises_to_pay"."status" = 'cancelled') = ("promises_to_pay"."cancel_reason" is not null)
        and ("promises_to_pay"."status" = 'cancelled') = ("promises_to_pay"."closed_by_member_id" is not null)
        and ("promises_to_pay"."paid_paise" is null or "promises_to_pay"."paid_paise" >= 0)),
	CONSTRAINT "promises_to_pay_text_lengths" CHECK (char_length("promises_to_pay"."note") <= 1000 and char_length("promises_to_pay"."cancel_reason") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "promises_to_pay" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "reminder_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"offset_days" integer NOT NULL,
	"channels" "message_channel"[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminder_schedules_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "reminder_schedules_offset_unique" UNIQUE("organization_id","offset_days"),
	CONSTRAINT "reminder_schedules_offset" CHECK ("reminder_schedules"."offset_days" between -30 and 90),
	CONSTRAINT "reminder_schedules_channels" CHECK (cardinality("reminder_schedules"."channels") between 1 and 3 and array_position("reminder_schedules"."channels", null) is null)
);
--> statement-breakpoint
ALTER TABLE "reminder_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "statement_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"from_on" date NOT NULL,
	"to_on" date NOT NULL,
	"language" "message_language" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_member_id" uuid,
	"opened_count" integer DEFAULT 0 NOT NULL,
	"last_opened_at" timestamp with time zone,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_links_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "statement_links_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "statement_links_period" CHECK ("statement_links"."from_on" <= "statement_links"."to_on"),
	CONSTRAINT "statement_links_token_hash" CHECK ("statement_links"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "statement_links_expiry" CHECK ("statement_links"."expires_at" > "statement_links"."created_at"),
	CONSTRAINT "statement_links_revoked" CHECK (("statement_links"."revoked_at" is null) = ("statement_links"."revoked_by_member_id" is null)),
	CONSTRAINT "statement_links_opened" CHECK ("statement_links"."opened_count" >= 0 and ("statement_links"."opened_count" = 0) = ("statement_links"."last_opened_at" is null))
);
--> statement-breakpoint
ALTER TABLE "statement_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "collection_escalations" ADD CONSTRAINT "collection_escalations_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_escalations" ADD CONSTRAINT "collection_escalations_promise_fk" FOREIGN KEY ("organization_id","promise_id") REFERENCES "public"."promises_to_pay"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_escalations" ADD CONSTRAINT "collection_escalations_acknowledged_by_fk" FOREIGN KEY ("organization_id","acknowledged_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_runs" ADD CONSTRAINT "collection_runs_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_outbox" ADD CONSTRAINT "message_outbox_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_updated_by_fk" FOREIGN KEY ("organization_id","updated_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_consents" ADD CONSTRAINT "messaging_consents_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messaging_consents" ADD CONSTRAINT "messaging_consents_recorded_by_fk" FOREIGN KEY ("organization_id","recorded_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Moved by hand: the key the foreign key below needs.
ALTER TABLE "activities" ADD CONSTRAINT "activities_organization_id_id_unique" UNIQUE("organization_id","id");--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_activity_fk" FOREIGN KEY ("organization_id","activity_id") REFERENCES "public"."activities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_closed_by_fk" FOREIGN KEY ("organization_id","closed_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_organization_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_links" ADD CONSTRAINT "statement_links_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_links" ADD CONSTRAINT "statement_links_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_links" ADD CONSTRAINT "statement_links_revoked_by_fk" FOREIGN KEY ("organization_id","revoked_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collection_escalations_open_idx" ON "collection_escalations" USING btree ("organization_id","created_at") WHERE "collection_escalations"."acknowledged_at" is null;--> statement-breakpoint
CREATE INDEX "collection_escalations_party_idx" ON "collection_escalations" USING btree ("organization_id","party_id");--> statement-breakpoint
CREATE INDEX "message_outbox_due_idx" ON "message_outbox" USING btree ("next_attempt_at") WHERE "message_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "message_outbox_party_idx" ON "message_outbox" USING btree ("organization_id","party_id","created_at");--> statement-breakpoint
CREATE INDEX "messaging_consents_party_idx" ON "messaging_consents" USING btree ("organization_id","party_id","channel","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "promises_to_pay_one_open_per_party" ON "promises_to_pay" USING btree ("party_id") WHERE "promises_to_pay"."status" = 'open';--> statement-breakpoint
CREATE INDEX "promises_to_pay_party_idx" ON "promises_to_pay" USING btree ("organization_id","party_id","created_at");--> statement-breakpoint
CREATE INDEX "promises_to_pay_open_due_idx" ON "promises_to_pay" USING btree ("organization_id","promised_on") WHERE "promises_to_pay"."status" = 'open';--> statement-breakpoint
CREATE INDEX "statement_links_party_idx" ON "statement_links" USING btree ("organization_id","party_id","created_at");--> statement-breakpoint
CREATE POLICY "collection_escalations_tenant_isolation" ON "collection_escalations" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("collection_escalations"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("collection_escalations"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "collection_runs_tenant_isolation" ON "collection_runs" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("collection_runs"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("collection_runs"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_outbox_tenant_isolation" ON "message_outbox" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("message_outbox"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("message_outbox"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "message_templates_tenant_isolation" ON "message_templates" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("message_templates"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("message_templates"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "messaging_consents_tenant_isolation" ON "messaging_consents" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("messaging_consents"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("messaging_consents"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "promises_to_pay_tenant_isolation" ON "promises_to_pay" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("promises_to_pay"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("promises_to_pay"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "reminder_schedules_tenant_isolation" ON "reminder_schedules" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("reminder_schedules"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("reminder_schedules"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "statement_links_tenant_isolation" ON "statement_links" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("statement_links"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("statement_links"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);