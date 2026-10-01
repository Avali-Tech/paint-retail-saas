CREATE TYPE "public"."project_party_role" AS ENUM('architect', 'contractor', 'painter', 'dealer');--> statement-breakpoint
CREATE TYPE "public"."project_stage" AS ENUM('identified', 'survey', 'specification', 'quotation', 'negotiation', 'order', 'execution', 'completed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."document_category" ADD VALUE 'before_photo';--> statement-breakpoint
ALTER TYPE "public"."document_category" ADD VALUE 'after_photo';--> statement-breakpoint
ALTER TYPE "public"."document_record_type" ADD VALUE 'lead';--> statement-breakpoint
ALTER TYPE "public"."document_record_type" ADD VALUE 'opportunity';--> statement-breakpoint
ALTER TYPE "public"."document_record_type" ADD VALUE 'project';--> statement-breakpoint
CREATE TABLE "project_parties" (
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" "project_party_role" NOT NULL,
	CONSTRAINT "project_parties_project_id_party_id_role_pk" PRIMARY KEY("project_id","party_id","role")
);
--> statement-breakpoint
ALTER TABLE "project_parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" text NOT NULL,
	"store_id" uuid NOT NULL,
	"name" text NOT NULL,
	"customer_party_id" uuid NOT NULL,
	"opportunity_id" uuid,
	"address_line" text,
	"city" text,
	"state" text,
	"pincode" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"start_date" date,
	"expected_completion_date" date,
	"estimated_area_sq_ft" numeric(12, 2),
	"estimated_paint_litres" numeric(12, 3),
	"expected_order_value_paise" bigint,
	"stage" "project_stage" DEFAULT 'identified' NOT NULL,
	"cancel_reason" text,
	"notes" text,
	"assigned_member_id" uuid NOT NULL,
	"created_by_member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "projects_organization_number_unique" UNIQUE("organization_id","number"),
	CONSTRAINT "projects_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "projects_opportunity_unique" UNIQUE("opportunity_id"),
	CONSTRAINT "projects_pin_complete" CHECK (("projects"."latitude" is null) = ("projects"."longitude" is null)),
	CONSTRAINT "projects_latitude_range" CHECK ("projects"."latitude" between -90 and 90),
	CONSTRAINT "projects_longitude_range" CHECK ("projects"."longitude" between -180 and 180),
	CONSTRAINT "projects_area_positive" CHECK ("projects"."estimated_area_sq_ft" > 0),
	CONSTRAINT "projects_paint_positive" CHECK ("projects"."estimated_paint_litres" > 0),
	CONSTRAINT "projects_value_not_negative" CHECK ("projects"."expected_order_value_paise" >= 0),
	CONSTRAINT "projects_dates_in_order" CHECK ("projects"."expected_completion_date" >= "projects"."start_date"),
	CONSTRAINT "projects_cancel_reason" CHECK (("projects"."stage" = 'cancelled') = ("projects"."cancel_reason" is not null)),
	CONSTRAINT "projects_closed_when_closed" CHECK (("projects"."stage" in ('completed', 'cancelled')) = ("projects"."closed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "project_parties" ADD CONSTRAINT "project_parties_project_fk" FOREIGN KEY ("organization_id","project_id") REFERENCES "public"."projects"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_parties" ADD CONSTRAINT "project_parties_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_store_fk" FOREIGN KEY ("organization_id","store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_fk" FOREIGN KEY ("organization_id","customer_party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_opportunity_fk" FOREIGN KEY ("organization_id","opportunity_id") REFERENCES "public"."opportunities"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_assigned_member_fk" FOREIGN KEY ("organization_id","assigned_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_fk" FOREIGN KEY ("organization_id","created_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_parties_party_idx" ON "project_parties" USING btree ("party_id");--> statement-breakpoint
CREATE INDEX "projects_store_stage_idx" ON "projects" USING btree ("organization_id","store_id","stage");--> statement-breakpoint
CREATE INDEX "projects_customer_idx" ON "projects" USING btree ("customer_party_id");--> statement-breakpoint
CREATE POLICY "project_parties_tenant_isolation" ON "project_parties" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("project_parties"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("project_parties"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "projects_tenant_isolation" ON "projects" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("projects"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("projects"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);