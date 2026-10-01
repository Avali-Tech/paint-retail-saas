-- Data migration: give existing organisations' standard roles the new
-- loyalty:read / loyalty:manage permissions, matching SYSTEM_ROLES in
-- @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'loyalty:read'),
  ('owner', 'loyalty:manage'),
  ('org_admin', 'loyalty:read'),
  ('org_admin', 'loyalty:manage'),
  ('branch_manager', 'loyalty:read'),
  ('branch_manager', 'loyalty:manage'),
  ('sales_executive', 'loyalty:read'),
  ('sales_executive', 'loyalty:manage'),
  ('crm_executive', 'loyalty:read'),
  ('crm_executive', 'loyalty:manage'),
  ('store_employee', 'loyalty:read')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
