-- White-label extras: each business's sign-in link name (slug) and its logo.

-- 1. Logos: the file lives in S3; this row says which file, what it is and who uploaded it.
CREATE TABLE "organization_logos" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"uploaded_by_member_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_logos_content_type" CHECK ("organization_logos"."content_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "organization_logos_sha256" CHECK ("organization_logos"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "organization_logos_dimensions" CHECK ("organization_logos"."width" > 0 and "organization_logos"."height" > 0 and "organization_logos"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "organization_logos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_logos" ADD CONSTRAINT "organization_logos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_logos" ADD CONSTRAINT "organization_logos_uploaded_by_fk" FOREIGN KEY ("organization_id","uploaded_by_member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "organization_logos_tenant_isolation" ON "organization_logos" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("organization_logos"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("organization_logos"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint

-- 2. Slugs. A name the database derives from the business's name: lower-case words
--    joined by hyphens, never one of the reserved names (RESERVED_SLUGS in
--    @paint/shared; an integration test keeps the lists in step), with -2, -3… added
--    when taken. One generation at a time (an advisory lock held to the end of the
--    transaction), so two sign-ups with the same name get different slugs.
ALTER TABLE "organizations" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE FUNCTION generate_organization_slug(business_name text, organization_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  reserved constant text[] := ARRAY[
    'about', 'account', 'accounts', 'admin', 'administrator', 'api', 'app', 'apps', 'assets',
    'auth', 'billing', 'blog', 'cdn', 'console', 'contact', 'dashboard', 'demo', 'dev', 'docs',
    'email', 'help', 'login', 'logout', 'mail', 'new', 'operator', 'paint-retail', 'paintretail',
    'platform', 'portal', 'privacy', 'prod', 'production', 'public', 'root', 'security',
    'settings', 'sign-in', 'sign-out', 'sign-up', 'signin', 'signout', 'signup', 'smtp',
    'staging', 'static', 'status', 'support', 'system', 'terms', 'test', 'www'
  ];
  base text;
  candidate text;
  suffix integer := 1;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('generate_organization_slug'));
  base := trim(both '-' from regexp_replace(lower(coalesce(business_name, '')), '[^a-z0-9]+', '-', 'g'));
  -- Room for a "-NNNN" suffix within the 40-character limit.
  base := trim(both '-' from left(base, 34));
  IF length(base) < 3 THEN
    base := concat_ws('-', nullif(base, ''), 'business');
  END IF;
  LOOP
    candidate := CASE WHEN suffix = 1 THEN base ELSE base || '-' || suffix END;
    EXIT WHEN NOT candidate = ANY (reserved) AND NOT EXISTS (
      SELECT 1 FROM organizations o
      WHERE lower(o.slug) = candidate AND o.id IS DISTINCT FROM organization_id
    );
    suffix := suffix + 1;
  END LOOP;
  RETURN candidate;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION generate_organization_slug(text, uuid) FROM PUBLIC;--> statement-breakpoint

-- Existing businesses, oldest first (so the first "Sharma Paints" keeps the plain name).
DO $$
DECLARE
  org record;
BEGIN
  FOR org IN SELECT id, name FROM organizations ORDER BY created_at, id LOOP
    UPDATE organizations SET slug = generate_organization_slug(org.name, org.id) WHERE id = org.id;
  END LOOP;
END
$$;--> statement-breakpoint
ALTER TABLE "organizations" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_unique" ON "organizations" USING btree (lower("slug"));--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_format" CHECK ("organizations"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("organizations"."slug") between 3 and 40);--> statement-breakpoint

-- New businesses get one at insert unless one is given (sign-up, the platform console,
-- the demo seed and tests all leave it out).
CREATE FUNCTION organizations_default_slug() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.slug IS NULL THEN
    NEW.slug := generate_organization_slug(NEW.name, NEW.id);
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION organizations_default_slug() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER organizations_slug
BEFORE INSERT ON organizations
FOR EACH ROW EXECUTE FUNCTION organizations_default_slug();--> statement-breakpoint

-- 3. Owners change their own business's slug (row-level security keeps it to theirs).
GRANT UPDATE (slug) ON organizations TO app_tenant;--> statement-breakpoint

-- 4. Audit log: slug changes, and every logo upload, replacement and removal.
DROP TRIGGER audit_organization_plan ON organizations;--> statement-breakpoint
CREATE TRIGGER audit_organization_plan
AFTER UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'plan', 'feature_flags', 'suspended_at', 'suspend_reason', 'two_factor_required', 'slug');--> statement-breakpoint
CREATE TRIGGER audit_organization_logos
AFTER INSERT OR UPDATE OR DELETE ON organization_logos
FOR EACH ROW EXECUTE FUNCTION audit_row_change('organization_id', 'sha256', 'content_type', 'width', 'height');
