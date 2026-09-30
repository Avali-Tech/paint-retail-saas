-- Data migration: give existing organisations' standard roles the new
-- parties:read / parties:manage permissions, matching SYSTEM_ROLES in
-- @paint/shared (new organisations get them at signup). Custom roles are left
-- for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'parties:read'),
  ('owner', 'parties:manage'),
  ('org_admin', 'parties:read'),
  ('org_admin', 'parties:manage'),
  ('branch_manager', 'parties:read'),
  ('branch_manager', 'parties:manage'),
  ('inventory_manager', 'parties:read'),
  ('sales_executive', 'parties:read'),
  ('sales_executive', 'parties:manage'),
  ('crm_executive', 'parties:read'),
  ('crm_executive', 'parties:manage'),
  ('store_employee', 'parties:read')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
