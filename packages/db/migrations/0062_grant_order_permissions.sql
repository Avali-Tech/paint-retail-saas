-- Data migration: give existing organisations' standard roles the new
-- sales:manage permission (quotations and sales orders), matching SYSTEM_ROLES
-- in @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'sales:manage'),
  ('org_admin', 'sales:manage'),
  ('branch_manager', 'sales:manage'),
  ('sales_executive', 'sales:manage')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
