-- Data migration: give existing organisations' owners and admins the new
-- tax:read / tax:manage permissions (Settings, Tax & GST), matching SYSTEM_ROLES
-- in @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'tax:read'),
  ('owner', 'tax:manage'),
  ('org_admin', 'tax:read'),
  ('org_admin', 'tax:manage')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
