CREATE TYPE "public"."payment_link_origin" AS ENUM('staff', 'reminder', 'statement');--> statement-breakpoint
CREATE TYPE "public"."payment_link_purpose" AS ENUM('invoice', 'overdue', 'outstanding', 'bills', 'advance');--> statement-breakpoint
CREATE TYPE "public"."payment_link_status" AS ENUM('created', 'paid', 'expired', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."message_template_key" ADD VALUE 'payment_request';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'payment_link_paid';--> statement-breakpoint
ALTER TYPE "public"."payment_gateway" ADD VALUE 'log';--> statement-breakpoint
ALTER TYPE "public"."payment_mode_kind" ADD VALUE 'upi_link';--> statement-breakpoint
CREATE TABLE "payment_link_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"document_id" uuid,
	"party_ledger_id" uuid,
	"position" integer NOT NULL,
	"outstanding_paise" bigint NOT NULL,
	CONSTRAINT "payment_link_documents_position_unique" UNIQUE("link_id","position"),
	CONSTRAINT "payment_link_documents_document_unique" UNIQUE("link_id","document_id"),
	CONSTRAINT "payment_link_documents_ledger_unique" UNIQUE("link_id","party_ledger_id"),
	CONSTRAINT "payment_link_documents_one_target" CHECK (num_nonnulls("payment_link_documents"."document_id", "payment_link_documents"."party_ledger_id") = 1),
	CONSTRAINT "payment_link_documents_amounts" CHECK ("payment_link_documents"."position" >= 0 and "payment_link_documents"."outstanding_paise" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_link_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"purpose" "payment_link_purpose" NOT NULL,
	"origin" "payment_link_origin" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"description" text NOT NULL,
	"provider" "payment_gateway" NOT NULL,
	"gateway_reference" text NOT NULL,
	"url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" "payment_link_status" DEFAULT 'created' NOT NULL,
	"paid_paise" bigint DEFAULT 0 NOT NULL,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_member_id" uuid,
	"created_by_member_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_links_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "payment_links_organization_id_party_unique" UNIQUE("organization_id","id","party_id"),
	CONSTRAINT "payment_links_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "payment_links_gateway_reference_unique" UNIQUE("provider","gateway_reference"),
	CONSTRAINT "payment_links_number_format" CHECK ("payment_links"."number" ~ '^PL-[0-9]{6,}$'),
	CONSTRAINT "payment_links_amount_positive" CHECK ("payment_links"."amount_paise" > 0),
	CONSTRAINT "payment_links_paid" CHECK ("payment_links"."paid_paise" >= 0),
	CONSTRAINT "payment_links_expiry" CHECK ("payment_links"."expires_at" > "payment_links"."created_at"),
	CONSTRAINT "payment_links_status" CHECK (("payment_links"."status" = 'paid') = ("payment_links"."paid_at" is not null)
        and ("payment_links"."status" <> 'cancelled' or "payment_links"."cancelled_at" is not null)
        and ("payment_links"."cancelled_at" is null or "payment_links"."status" in ('cancelled', 'paid'))
        and ("payment_links"."cancelled_by_member_id" is null or "payment_links"."cancelled_at" is not null)),
	CONSTRAINT "payment_links_text_lengths" CHECK (char_length("payment_links"."description") between 1 and 200
        and char_length("payment_links"."gateway_reference") between 1 and 200
        and char_length("payment_links"."url") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "payment_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "created_by_member_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_link_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_link_documents" ADD CONSTRAINT "payment_link_documents_link_fk" FOREIGN KEY ("organization_id","link_id","party_id") REFERENCES "public"."payment_links"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_documents" ADD CONSTRAINT "payment_link_documents_document_fk" FOREIGN KEY ("organization_id","document_id","party_id") REFERENCES "public"."tax_documents"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_link_documents" ADD CONSTRAINT "payment_link_documents_party_ledger_fk" FOREIGN KEY ("organization_id","party_ledger_id","party_id") REFERENCES "public"."party_ledger"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_cancelled_by_fk" FOREIGN KEY ("organization_id","cancelled_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_link_documents_document_idx" ON "payment_link_documents" USING btree ("document_id") WHERE "payment_link_documents"."document_id" is not null;--> statement-breakpoint
CREATE INDEX "payment_links_party_idx" ON "payment_links" USING btree ("organization_id","party_id","created_at" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "payment_links_organization_created_idx" ON "payment_links" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_link_fk" FOREIGN KEY ("organization_id","payment_link_id","party_id") REFERENCES "public"."payment_links"("organization_id","id","party_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_link_gateway_reference_unique" ON "payments" USING btree ("organization_id","gateway_reference") WHERE "payments"."payment_link_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_payment_link_idx" ON "payments" USING btree ("payment_link_id") WHERE "payments"."payment_link_id" is not null;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_link" CHECK (("payments"."payment_link_id" is null
          or ("payments"."direction" = 'in' and "payments"."gateway_reference" is not null
            and "payments"."register_session_id" is null))
        and ("payments"."mode_kind"::text = 'upi_link') = ("payments"."payment_link_id" is not null)
        and ("payments"."created_by_member_id" is not null or "payments"."payment_link_id" is not null));--> statement-breakpoint
CREATE POLICY "payment_link_documents_tenant_isolation" ON "payment_link_documents" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("payment_link_documents"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("payment_link_documents"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payment_links_tenant_isolation" ON "payment_links" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("payment_links"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("payment_links"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);