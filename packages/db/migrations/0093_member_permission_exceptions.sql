CREATE TABLE "member_permission_exceptions" (
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted" boolean NOT NULL,
	CONSTRAINT "member_permission_exceptions_member_id_permission_pk" PRIMARY KEY("member_id","permission")
);
--> statement-breakpoint
ALTER TABLE "member_permission_exceptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "member_permission_exceptions" ADD CONSTRAINT "member_permission_exceptions_member_fk" FOREIGN KEY ("organization_id","member_id") REFERENCES "public"."organization_members"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "member_permission_exceptions_tenant_isolation" ON "member_permission_exceptions" AS PERMISSIVE FOR ALL TO "app_tenant" USING ("member_permission_exceptions"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid) WITH CHECK ("member_permission_exceptions"."organization_id" = nullif(current_setting('app.current_organization_id', true), '')::uuid);--> statement-breakpoint
CREATE TRIGGER audit_member_permission_exceptions
AFTER INSERT OR UPDATE OR DELETE ON member_permission_exceptions
FOR EACH ROW EXECUTE FUNCTION audit_row_change('member_id', 'permission', 'granted');--> statement-breakpoint

-- Data migration: four permissions split out of broader ones. Every role, standard or
-- custom, that could do the thing before gets the new permission, so nothing changes until
-- an owner takes it away; SYSTEM_ROLES in @paint/shared match. Safe to re-run.
--   billing:discount   (discounts and changed prices on bills, quotes and orders)
--   billing:on_account (leaving part of a bill on the customer's account)
--   costs:read         (average cost, stock value and margins)
--   data:export        (CSV downloads)
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT DISTINCT rp.organization_id, rp.role_id, split.permission
FROM role_permissions rp
JOIN (VALUES
  ('billing:discount', 'billing:issue'),
  ('billing:discount', 'sales:manage'),
  ('billing:on_account', 'billing:issue'),
  ('billing:on_account', 'sales:manage'),
  ('costs:read', 'inventory:read'),
  ('costs:read', 'purchasing:read'),
  ('costs:read', 'accounting:export')
) AS split (permission, parent) ON split.parent = rp.permission
ON CONFLICT (role_id, permission) DO NOTHING;--> statement-breakpoint

INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, 'data:export'
FROM roles r
ON CONFLICT (role_id, permission) DO NOTHING;
