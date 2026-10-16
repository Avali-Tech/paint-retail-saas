CREATE TYPE "public"."billing_interval" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."subscription_checkout_status" AS ENUM('open', 'paid');--> statement-breakpoint
CREATE TYPE "public"."payment_gateway" AS ENUM('fake', 'razorpay');--> statement-breakpoint
CREATE TYPE "public"."plan_change_source" AS ENUM('signup', 'owner', 'operator', 'gateway');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'cancelled', 'expired');--> statement-breakpoint
ALTER TYPE "public"."plan" ADD VALUE 'starter' BEFORE 'standard';--> statement-breakpoint
CREATE TABLE "payment_gateway_events" (
	"gateway" "payment_gateway" NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"object_id" text,
	"organization_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gateway_events_gateway_event_id_pk" PRIMARY KEY("gateway","event_id")
);
--> statement-breakpoint
ALTER TABLE "payment_gateway_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan" "plan" NOT NULL,
	"billing_interval" "billing_interval" NOT NULL,
	"store_quantity" integer NOT NULL,
	"total_paise" bigint NOT NULL,
	"gateway" "payment_gateway" NOT NULL,
	"gateway_subscription_id" text NOT NULL,
	"checkout_url" text NOT NULL,
	"status" "subscription_checkout_status" DEFAULT 'open' NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "subscription_checkouts_plan_paid" CHECK ("subscription_checkouts"."plan" <> 'trial'),
	CONSTRAINT "subscription_checkouts_quantity" CHECK ("subscription_checkouts"."store_quantity" > 0),
	CONSTRAINT "subscription_checkouts_total" CHECK ("subscription_checkouts"."total_paise" > 0),
	CONSTRAINT "subscription_checkouts_paid_at" CHECK (("subscription_checkouts"."status" = 'paid') = ("subscription_checkouts"."paid_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_invoice_sequences" (
	"financial_year" text PRIMARY KEY NOT NULL,
	"last_value" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_invoice_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"financial_year" text NOT NULL,
	"serial" integer NOT NULL,
	"issued_on" date NOT NULL,
	"plan" "plan" NOT NULL,
	"billing_interval" "billing_interval" NOT NULL,
	"store_quantity" integer NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"sac_code" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"place_of_supply" text NOT NULL,
	"taxable_paise" bigint NOT NULL,
	"cgst_paise" bigint NOT NULL,
	"sgst_paise" bigint NOT NULL,
	"igst_paise" bigint NOT NULL,
	"total_paise" bigint NOT NULL,
	"supplier" jsonb NOT NULL,
	"buyer" jsonb NOT NULL,
	"gateway" "payment_gateway" NOT NULL,
	"gateway_payment_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_invoices_number_unique" UNIQUE("number"),
	CONSTRAINT "subscription_invoices_serial_unique" UNIQUE("financial_year","serial"),
	CONSTRAINT "subscription_invoices_plan_paid" CHECK ("subscription_invoices"."plan" <> 'trial'),
	CONSTRAINT "subscription_invoices_quantity" CHECK ("subscription_invoices"."store_quantity" > 0),
	CONSTRAINT "subscription_invoices_total" CHECK ("subscription_invoices"."total_paise" = "subscription_invoices"."taxable_paise" + "subscription_invoices"."cgst_paise" + "subscription_invoices"."sgst_paise" + "subscription_invoices"."igst_paise"),
	CONSTRAINT "subscription_invoices_period" CHECK ("subscription_invoices"."period_end" >= "subscription_invoices"."period_start")
);
--> statement-breakpoint
ALTER TABLE "subscription_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscription_plan_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_plan" "plan",
	"to_plan" "plan" NOT NULL,
	"billing_interval" "billing_interval",
	"source" "plan_change_source" NOT NULL,
	"changed_by_member_id" uuid,
	"changed_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscription_plan_changes_who" CHECK (("subscription_plan_changes"."source" = 'owner') = ("subscription_plan_changes"."changed_by_member_id" is not null)
        and ("subscription_plan_changes"."source" = 'operator') = ("subscription_plan_changes"."changed_by_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "subscription_plan_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"status" "subscription_status" NOT NULL,
	"billing_interval" "billing_interval",
	"store_quantity" integer,
	"trial_ends_at" timestamp with time zone,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"past_due_since" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"gateway" "payment_gateway",
	"gateway_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_trial_end" CHECK ("subscriptions"."status" <> 'trialing' or "subscriptions"."trial_ends_at" is not null),
	CONSTRAINT "subscriptions_past_due_since" CHECK (("subscriptions"."status" = 'past_due') = ("subscriptions"."past_due_since" is not null)),
	CONSTRAINT "subscriptions_gateway_id" CHECK (("subscriptions"."gateway" is null) = ("subscriptions"."gateway_subscription_id" is null)),
	CONSTRAINT "subscriptions_paid_billing" CHECK (("subscriptions"."gateway" is null) or ("subscriptions"."billing_interval" is not null and "subscriptions"."store_quantity" > 0 and "subscriptions"."current_period_end" is not null)),
	CONSTRAINT "subscriptions_period_order" CHECK ("subscriptions"."current_period_start" is null or "subscriptions"."current_period_end" > "subscriptions"."current_period_start")
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_gateway_events" ADD CONSTRAINT "payment_gateway_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_checkouts" ADD CONSTRAINT "subscription_checkouts_member_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_plan_changes" ADD CONSTRAINT "subscription_plan_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_plan_changes" ADD CONSTRAINT "subscription_plan_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_plan_changes" ADD CONSTRAINT "subscription_plan_changes_member_fk" FOREIGN KEY ("organization_id","changed_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_checkouts_gateway_unique" ON "subscription_checkouts" USING btree ("gateway","gateway_subscription_id");--> statement-breakpoint
CREATE INDEX "subscription_checkouts_organization_idx" ON "subscription_checkouts" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_invoices_payment_unique" ON "subscription_invoices" USING btree ("gateway","gateway_payment_id");--> statement-breakpoint
CREATE INDEX "subscription_invoices_organization_idx" ON "subscription_invoices" USING btree ("organization_id","issued_on" DESC NULLS FIRST,"serial" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "subscription_plan_changes_organization_idx" ON "subscription_plan_changes" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_gateway_subscription_unique" ON "subscriptions" USING btree ("gateway","gateway_subscription_id");--> statement-breakpoint
CREATE POLICY "subscription_checkouts_tenant_read" ON "subscription_checkouts" AS PERMISSIVE FOR SELECT TO "app_tenant" USING ("subscription_checkouts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_invoices_tenant_read" ON "subscription_invoices" AS PERMISSIVE FOR SELECT TO "app_tenant" USING ("subscription_invoices"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscription_plan_changes_tenant_read" ON "subscription_plan_changes" AS PERMISSIVE FOR SELECT TO "app_tenant" USING ("subscription_plan_changes"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "subscriptions_tenant_read" ON "subscriptions" AS PERMISSIVE FOR SELECT TO "app_tenant" USING ("subscriptions"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);