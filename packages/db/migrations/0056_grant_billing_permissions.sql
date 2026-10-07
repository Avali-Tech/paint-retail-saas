-- Data migration: give existing organisations' standard roles the new
-- sales:read / billing:issue / billing:cancel permissions (invoices and bills
-- of supply), matching SYSTEM_ROLES in @paint/shared. Custom roles are left for
-- owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, grants.permission
FROM roles r
JOIN (VALUES
  ('owner', 'sales:read'),
  ('owner', 'billing:issue'),
  ('owner', 'billing:cancel'),
  ('org_admin', 'sales:read'),
  ('org_admin', 'billing:issue'),
  ('org_admin', 'billing:cancel'),
  ('branch_manager', 'sales:read'),
  ('branch_manager', 'billing:issue'),
  ('branch_manager', 'billing:cancel'),
  ('sales_executive', 'sales:read'),
  ('sales_executive', 'billing:issue'),
  ('store_employee', 'sales:read'),
  ('store_employee', 'billing:issue')
) AS grants (role_key, permission) ON grants.role_key = r.key
WHERE r.is_system
ON CONFLICT (role_id, permission) DO NOTHING;
