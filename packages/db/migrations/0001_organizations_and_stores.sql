CREATE TYPE "public"."location_type" AS ENUM('store', 'godown');--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"type" "location_type" DEFAULT 'store' NOT NULL,
	"city" text,
	"state" text,
	"gstin" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stores_organization_code_unique" UNIQUE("organization_id","code")
);
--> statement-breakpoint
ALTER TABLE "stores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stores_organization_id_idx" ON "stores" USING btree ("organization_id");--> statement-breakpoint
CREATE POLICY "organizations_tenant_select" ON "organizations" AS PERMISSIVE FOR SELECT TO "app_tenant" USING ("organizations"."id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "organizations_tenant_update" ON "organizations" AS PERMISSIVE FOR UPDATE TO "app_tenant" USING ("organizations"."id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organizations"."id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "stores_tenant_isolation" ON "stores" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("stores"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("stores"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);