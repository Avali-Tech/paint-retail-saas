CREATE TYPE "public"."payment_link_amount_basis" AS ENUM('net', 'full');--> statement-breakpoint
CREATE TYPE "public"."payment_link_refund_reason" AS ENUM('settled', 'overpaid');--> statement-breakpoint
CREATE TYPE "public"."payment_link_refund_status" AS ENUM('pending', 'refunded', 'failed', 'dropped', 'returned');--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'payment_link_refund';--> statement-breakpoint
CREATE TABLE "payment_gateway_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"gateway" "payment_gateway" NOT NULL,
	"webhook_ref" text NOT NULL,
	"key_id_hint" text,
	"key_secret_hint" text,
	"webhook_secret_hint" text,
	"live" boolean,
	"credentials_sealed" text,
	"connected_at" timestamp with time zone,
	"connected_by_member_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gateway_accounts_organization_unique" UNIQUE("organization_id"),
	CONSTRAINT "payment_gateway_accounts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "payment_gateway_accounts_webhook_ref_unique" UNIQUE("webhook_ref"),
	CONSTRAINT "payment_gateway_accounts_gateway" CHECK ("payment_gateway_accounts"."gateway"::text = 'razorpay'),
	CONSTRAINT "payment_gateway_accounts_webhook_ref" CHECK ("payment_gateway_accounts"."webhook_ref" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "payment_gateway_accounts_connected" CHECK (num_nonnulls("payment_gateway_accounts"."key_id_hint", "payment_gateway_accounts"."key_secret_hint", "payment_gateway_accounts"."webhook_secret_hint",
          "payment_gateway_accounts"."live", "payment_gateway_accounts"."credentials_sealed", "payment_gateway_accounts"."connected_at") in (0, 6)
        and ("payment_gateway_accounts"."connected_by_member_id" is null or "payment_gateway_accounts"."connected_at" is not null)
        and ("payment_gateway_accounts"."verified_at" is null or "payment_gateway_accounts"."connected_at" is not null)),
	CONSTRAINT "payment_gateway_accounts_hints" CHECK (char_length("payment_gateway_accounts"."key_id_hint") = 4 and char_length("payment_gateway_accounts"."key_secret_hint") = 4
        and char_length("payment_gateway_accounts"."webhook_secret_hint") = 4
        and "payment_gateway_accounts"."credentials_sealed" ~ '^v1:' and char_length("payment_gateway_accounts"."credentials_sealed") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "payment_gateway_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_link_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"gateway_payment_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"reason" "payment_link_refund_reason" NOT NULL,
	"provider" "payment_gateway" NOT NULL,
	"status" "payment_link_refund_status" DEFAULT 'pending' NOT NULL,
	"gateway_refund_id" text,
	"gateway_status" text,
	"refund_payment_id" uuid,
	"returned_payment_id" uuid,
	"retry_of_id" uuid,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"flagged_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_link_refunds_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "payment_link_refunds_gateway_unique" UNIQUE("provider","gateway_refund_id"),
	CONSTRAINT "payment_link_refunds_amount_positive" CHECK ("payment_link_refunds"."amount_paise" > 0),
	CONSTRAINT "payment_link_refunds_attempts" CHECK ("payment_link_refunds"."attempts" >= 0),
	CONSTRAINT "payment_link_refunds_status" CHECK (("payment_link_refunds"."status" in ('refunded', 'returned')) = ("payment_link_refunds"."refund_payment_id" is not null)
        and ("payment_link_refunds"."refund_payment_id" is null or "payment_link_refunds"."gateway_refund_id" is not null)
        and ("payment_link_refunds"."status" in ('refunded', 'returned')) = ("payment_link_refunds"."refunded_at" is not null)
        and ("payment_link_refunds"."status" = 'returned') = ("payment_link_refunds"."returned_payment_id" is not null)),
	CONSTRAINT "payment_link_refunds_text_lengths" CHECK (char_length("payment_link_refunds"."gateway_payment_id") between 1 and 200
        and char_length("payment_link_refunds"."gateway_refund_id") between 1 and 200
        and char_length("payment_link_refunds"."gateway_status") <= 40 and char_length("payment_link_refunds"."last_error") <= 200)
);
--> statement-breakpoint
ALTER TABLE "payment_link_refunds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_link";--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "payment_link_validity_minutes" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "payment_link_cap_paise" bigint DEFAULT 10000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_settings" ADD COLUMN "payment_link_amount_basis" "payment_link_amount_basis" DEFAULT 'net' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_gateway_accounts" ADD CONSTRAINT "payment_gateway_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_accounts" ADD CONSTRAINT "payment_gateway_accounts_connected_by_fk" FOREIGN KEY ("organization_id","connected_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_refunds" ADD CONSTRAINT "payment_link_refunds_link_fk" FOREIGN KEY ("organization_id","link_id","party_id") REFERENCES "public"."payment_links"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_refunds" ADD CONSTRAINT "payment_link_refunds_payment_fk" FOREIGN KEY ("organization_id","payment_id","party_id") REFERENCES "public"."payments"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_refunds" ADD CONSTRAINT "payment_link_refunds_refund_payment_fk" FOREIGN KEY ("organization_id","refund_payment_id","party_id") REFERENCES "public"."payments"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_refunds" ADD CONSTRAINT "payment_link_refunds_returned_payment_fk" FOREIGN KEY ("organization_id","returned_payment_id","party_id") REFERENCES "public"."payments"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_refunds" ADD CONSTRAINT "payment_link_refunds_retry_of_fk" FOREIGN KEY ("organization_id","retry_of_id") REFERENCES "public"."payment_link_refunds"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_link_refunds_link_idx" ON "payment_link_refunds" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "payment_link_refunds_payment_idx" ON "payment_link_refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_link_refunds_due_idx" ON "payment_link_refunds" USING btree ("next_attempt_at") WHERE "payment_link_refunds"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_link" CHECK (("payments"."payment_link_id" is null
          or ("payments"."gateway_reference" is not null and "payments"."register_session_id" is null))
        and ("payments"."mode_kind"::text = 'upi_link') = ("payments"."payment_link_id" is not null)
        and ("payments"."created_by_member_id" is not null or "payments"."payment_link_id" is not null));--> statement-breakpoint
ALTER TABLE "sales_settings" ADD CONSTRAINT "sales_settings_payment_links" CHECK ("sales_settings"."payment_link_validity_minutes" between 5 and 43200
        and "sales_settings"."payment_link_cap_paise" between 100 and 50000000);--> statement-breakpoint
CREATE POLICY "payment_gateway_accounts_tenant_isolation" ON "payment_gateway_accounts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("payment_gateway_accounts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("payment_gateway_accounts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_link_refunds_tenant_isolation" ON "payment_link_refunds" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("payment_link_refunds"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("payment_link_refunds"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);