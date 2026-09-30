-- Data migration: give existing organisations' standard roles the new
-- catalog:read / catalog:manage permissions, matching SYSTEM_ROLES in
-- @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'catalog:read'),
  ('owner', 'catalog:manage'),
  ('org_admin', 'catalog:read'),
  ('org_admin', 'catalog:manage'),
  ('branch_manager', 'catalog:read'),
  ('inventory_manager', 'catalog:read'),
  ('inventory_manager', 'catalog:manage'),
  ('sales_executive', 'catalog:read'),
  ('crm_executive', 'catalog:read'),
  ('store_employee', 'catalog:read')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
