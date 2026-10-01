-- Data migration: give existing organisations' standard roles the new
-- projects:read / projects:manage permissions, matching SYSTEM_ROLES in
-- @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'projects:read'),
  ('owner', 'projects:manage'),
  ('org_admin', 'projects:read'),
  ('org_admin', 'projects:manage'),
  ('branch_manager', 'projects:read'),
  ('branch_manager', 'projects:manage'),
  ('sales_executive', 'projects:read'),
  ('sales_executive', 'projects:manage'),
  ('crm_executive', 'projects:read'),
  ('crm_executive', 'projects:manage')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
