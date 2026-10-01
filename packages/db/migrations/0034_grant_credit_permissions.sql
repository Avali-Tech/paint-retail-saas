-- Data migration: give existing organisations' standard roles the new
-- credit:read / credit:manage / credit:approve permissions, matching
-- SYSTEM_ROLES in @paint/shared. Custom roles are left for owners to adjust.
-- Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'credit:read'),
  ('owner', 'credit:manage'),
  ('owner', 'credit:approve'),
  ('org_admin', 'credit:read'),
  ('org_admin', 'credit:manage'),
  ('org_admin', 'credit:approve'),
  ('branch_manager', 'credit:read'),
  ('branch_manager', 'credit:manage'),
  ('sales_executive', 'credit:read'),
  ('sales_executive', 'credit:manage'),
  ('crm_executive', 'credit:read'),
  ('crm_executive', 'credit:manage')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
