-- Data migration: give existing organisations' standard roles the new
-- payments:manage / register:manage / billing:notes / accounting:export
-- permissions, matching SYSTEM_ROLES in @paint/shared. Custom roles are left
-- for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'payments:manage'),
  ('owner', 'register:manage'),
  ('owner', 'billing:notes'),
  ('owner', 'accounting:export'),
  ('org_admin', 'payments:manage'),
  ('org_admin', 'register:manage'),
  ('org_admin', 'billing:notes'),
  ('org_admin', 'accounting:export'),
  ('branch_manager', 'payments:manage'),
  ('branch_manager', 'register:manage'),
  ('branch_manager', 'billing:notes'),
  ('sales_executive', 'payments:manage'),
  ('store_employee', 'register:manage')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
