CREATE TABLE "organization_branding" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"branding" jsonb NOT NULL,
	"updated_by_member_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_branding_object" CHECK (jsonb_typeof("organization_branding"."branding") = 'object')
);
--> statement-breakpoint
ALTER TABLE "organization_branding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_branding" ADD CONSTRAINT "organization_branding_updated_by_fk" FOREIGN KEY ("organization_id","updated_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "organization_branding_tenant_isolation" ON "organization_branding" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("organization_branding"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_branding"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);