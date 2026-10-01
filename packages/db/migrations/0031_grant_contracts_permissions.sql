-- Data migration: give existing organisations' standard roles the new
-- contracts:read / contracts:manage permissions, matching SYSTEM_ROLES in
-- @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'contracts:read'),
  ('owner', 'contracts:manage'),
  ('org_admin', 'contracts:read'),
  ('org_admin', 'contracts:manage'),
  ('branch_manager', 'contracts:read'),
  ('branch_manager', 'contracts:manage'),
  ('inventory_manager', 'contracts:read'),
  ('sales_executive', 'contracts:read'),
  ('crm_executive', 'contracts:read'),
  ('crm_executive', 'contracts:manage')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
