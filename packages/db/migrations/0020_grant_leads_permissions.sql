-- Data migration: give existing organisations' standard roles the new
-- leads:read / leads:manage permissions, matching SYSTEM_ROLES in
-- @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'leads:read'),
  ('owner', 'leads:manage'),
  ('org_admin', 'leads:read'),
  ('org_admin', 'leads:manage'),
  ('branch_manager', 'leads:read'),
  ('branch_manager', 'leads:manage'),
  ('sales_executive', 'leads:read'),
  ('sales_executive', 'leads:manage'),
  ('crm_executive', 'leads:read'),
  ('crm_executive', 'leads:manage')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
