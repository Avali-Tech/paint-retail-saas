CREATE TYPE "public"."contract_status" AS ENUM('draft', 'active', 'terminated', 'renewed');--> statement-breakpoint
CREATE TYPE "public"."contract_type" AS ENUM('contractor_agreement', 'supplier_agreement', 'customer_agreement', 'dealer_agreement', 'other');--> statement-breakpoint
ALTER TYPE "public"."document_record_type" ADD VALUE 'contract';--> statement-breakpoint
ALTER TYPE "public"."notification_event" ADD VALUE 'contract_renewal_due';--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"type" "contract_type" NOT NULL,
	"title" text NOT NULL,
	"party_id" uuid NOT NULL,
	"store_id" uuid,
	"project_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"renewal_date" date NOT NULL,
	"value_paise" bigint,
	"terms" text,
	"credit_terms" text,
	"discount_terms" text,
	"notes" text,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"termination_reason" text,
	"renewal_of_id" uuid,
	"reminded_at" timestamp with time zone,
	"assigned_member_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "contracts_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "contracts_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "contracts_renewal_of_unique" UNIQUE("renewal_of_id"),
	CONSTRAINT "contracts_dates_in_order" CHECK ("contracts"."end_date" >= "contracts"."start_date"),
	CONSTRAINT "contracts_renewal_by_end" CHECK ("contracts"."renewal_date" <= "contracts"."end_date"),
	CONSTRAINT "contracts_value_not_negative" CHECK ("contracts"."value_paise" >= 0),
	CONSTRAINT "contracts_termination_reason" CHECK (("contracts"."status" = 'terminated') = ("contracts"."termination_reason" is not null)),
	CONSTRAINT "contracts_ended_when_ended" CHECK (("contracts"."status" in ('terminated', 'renewed')) = ("contracts"."ended_at" is not null)),
	CONSTRAINT "contracts_not_own_renewal" CHECK ("contracts"."renewal_of_id" <> "contracts"."id")
);
--> statement-breakpoint
ALTER TABLE "contracts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_renewal_of_fk" FOREIGN KEY ("organization_id","renewal_of_id") REFERENCES "public"."contracts"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_assigned_member_fk" FOREIGN KEY ("organization_id","assigned_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contracts_party_idx" ON "contracts" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "contracts_store_status_idx" ON "contracts" USING btree ("organization_id","store_id","status");--> statement-breakpoint
CREATE INDEX "contracts_reminder_idx" ON "contracts" USING btree ("renewal_date") WHERE "contracts"."status" = 'active' and "contracts"."reminded_at" is null;--> statement-breakpoint
CREATE POLICY "contracts_tenant_isolation" ON "contracts" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("contracts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("contracts"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);