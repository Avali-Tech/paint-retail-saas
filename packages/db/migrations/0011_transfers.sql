CREATE TYPE "public"."transfer_status" AS ENUM('requested', 'approved', 'in_transit', 'received', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "document_sequences" (
	"organization_id" uuid NOT NULL,
	"series" text NOT NULL,
	"last_value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "document_sequences_organization_id_series_pk" PRIMARY KEY("organization_id","series"),
	CONSTRAINT "document_sequences_last_value_not_negative" CHECK ("document_sequences"."last_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "document_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transfer_lines" (
	"organization_id" uuid NOT NULL,
	"transfer_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	"requested_quantity" numeric(14, 3) NOT NULL,
	"approved_quantity" numeric(14, 3),
	"dispatched_quantity" numeric(14, 3),
	"received_quantity" numeric(14, 3),
	"damaged_quantity" numeric(14, 3),
	CONSTRAINT "transfer_lines_transfer_id_variant_id_pk" PRIMARY KEY("transfer_id","variant_id"),
	CONSTRAINT "transfer_lines_requested_positive" CHECK ("transfer_lines"."requested_quantity" > 0),
	CONSTRAINT "transfer_lines_approved_within_requested" CHECK ("transfer_lines"."approved_quantity" >= 0 and "transfer_lines"."approved_quantity" <= "transfer_lines"."requested_quantity"),
	CONSTRAINT "transfer_lines_dispatched_within_approved" CHECK ("transfer_lines"."dispatched_quantity" >= 0 and "transfer_lines"."dispatched_quantity" <= "transfer_lines"."approved_quantity"),
	CONSTRAINT "transfer_lines_received_within_dispatched" CHECK ("transfer_lines"."received_quantity" >= 0 and "transfer_lines"."damaged_quantity" >= 0
        and "transfer_lines"."received_quantity" + "transfer_lines"."damaged_quantity" <= "transfer_lines"."dispatched_quantity")
);
--> statement-breakpoint
ALTER TABLE "transfer_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"from_store_id" uuid NOT NULL,
	"to_store_id" uuid NOT NULL,
	"status" "transfer_status" DEFAULT 'requested' NOT NULL,
	"note" text,
	"closing_reason" text,
	"requested_by_member_id" uuid NOT NULL,
	"approved_by_member_id" uuid,
	"dispatched_by_member_id" uuid,
	"received_by_member_id" uuid,
	"closed_by_member_id" uuid,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfers_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "transfers_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "transfers_different_stores" CHECK ("transfers"."from_store_id" <> "transfers"."to_store_id")
);
--> statement-breakpoint
ALTER TABLE "transfers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_transfer_fk" FOREIGN KEY ("organization_id","transfer_id") REFERENCES "public"."transfers"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_lines" ADD CONSTRAINT "transfer_lines_variant_fk" FOREIGN KEY ("organization_id","variant_id") REFERENCES "public"."product_variants"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_from_store_fk" FOREIGN KEY ("organization_id","from_store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_to_store_fk" FOREIGN KEY ("organization_id","to_store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_requested_by_fk" FOREIGN KEY ("organization_id","requested_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transfers_from_store_status_idx" ON "transfers" USING btree ("organization_id","from_store_id","status");--> statement-breakpoint
CREATE INDEX "transfers_to_store_status_idx" ON "transfers" USING btree ("organization_id","to_store_id","status");--> statement-breakpoint
CREATE POLICY "document_sequences_tenant_isolation" ON "document_sequences" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("document_sequences"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("document_sequences"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "transfer_lines_tenant_isolation" ON "transfer_lines" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("transfer_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("transfer_lines"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "transfers_tenant_isolation" ON "transfers" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("transfers"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("transfers"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);