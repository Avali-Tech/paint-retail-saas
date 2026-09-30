-- Data migration: give existing organisations' standard roles the new
-- inventory:read / inventory:manage permissions, matching SYSTEM_ROLES in
-- @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'inventory:read'),
  ('owner', 'inventory:manage'),
  ('org_admin', 'inventory:read'),
  ('org_admin', 'inventory:manage'),
  ('branch_manager', 'inventory:read'),
  ('branch_manager', 'inventory:manage'),
  ('inventory_manager', 'inventory:read'),
  ('inventory_manager', 'inventory:manage'),
  ('sales_executive', 'inventory:read'),
  ('store_employee', 'inventory:read')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
