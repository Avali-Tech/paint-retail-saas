CREATE TYPE "public"."contact_method" AS ENUM('phone', 'whatsapp', 'email', 'visit');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('retail', 'contractor', 'painter', 'dealer', 'builder', 'corporate');--> statement-breakpoint
CREATE TYPE "public"."party_kind" AS ENUM('person', 'organization');--> statement-breakpoint
CREATE TYPE "public"."party_role" AS ENUM('customer', 'contractor', 'painter', 'architect', 'dealer', 'supplier', 'distributor', 'sub_dealer');--> statement-breakpoint
CREATE TABLE "customer_profiles" (
	"party_id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_type" "customer_type" DEFAULT 'retail' NOT NULL,
	"assigned_member_id" uuid,
	"preferred_contact" "contact_method" DEFAULT 'phone' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "party_kind" DEFAULT 'person' NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"contact_person" text,
	"phone" text,
	"alternate_phone" text,
	"email" text,
	"gstin" text,
	"pan" text,
	"address_line" text,
	"city" text,
	"state" text,
	"pincode" text,
	"home_store_id" uuid,
	"notes" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "parties_organization_phone_unique" UNIQUE("organization_id","phone"),
	CONSTRAINT "parties_organization_gstin_unique" UNIQUE("organization_id","gstin"),
	CONSTRAINT "parties_organization_id_id_unique" UNIQUE("organization_id","id"),
	CONSTRAINT "parties_phone_e164" CHECK ("parties"."phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "parties_alternate_phone_e164" CHECK ("parties"."alternate_phone" ~ '^\+[1-9][0-9]{7,14}$'),
	CONSTRAINT "parties_email_lowercase" CHECK ("parties"."email" = lower("parties"."email")),
	CONSTRAINT "parties_gstin_format" CHECK ("parties"."gstin" ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
	CONSTRAINT "parties_pan_format" CHECK ("parties"."pan" ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
	CONSTRAINT "parties_pincode_format" CHECK ("parties"."pincode" ~ '^[1-9][0-9]{5}$')
);
--> statement-breakpoint
ALTER TABLE "parties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "party_roles" (
	"organization_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"role" "party_role" NOT NULL,
	CONSTRAINT "party_roles_party_id_role_pk" PRIMARY KEY("party_id","role")
);
--> statement-breakpoint
ALTER TABLE "party_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_assigned_member_fk" FOREIGN KEY ("organization_id","assigned_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parties" ADD CONSTRAINT "parties_home_store_fk" FOREIGN KEY ("organization_id","home_store_id") REFERENCES "public"."stores"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "party_roles" ADD CONSTRAINT "party_roles_party_fk" FOREIGN KEY ("organization_id","party_id") REFERENCES "public"."parties"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "parties_organization_display_name_idx" ON "parties" USING btree ("organization_id","display_name");--> statement-breakpoint
CREATE INDEX "party_roles_organization_role_idx" ON "party_roles" USING btree ("organization_id","role");--> statement-breakpoint
CREATE POLICY "customer_profiles_tenant_isolation" ON "customer_profiles" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("customer_profiles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("customer_profiles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "parties_tenant_isolation" ON "parties" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("parties"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("parties"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "party_roles_tenant_isolation" ON "party_roles" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("party_roles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("party_roles"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);