-- Data migration: give existing organisations' standard roles the new
-- receivables:read permission (the receivables dashboard, ageing and the
-- collections worklist, P2-M10 / P2-M11; spec §6.4), matching SYSTEM_ROLES in
-- @paint/shared. Custom roles are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, 'receivables:read'
FROM roles r
WHERE r.is_system AND r.key IN ('owner', 'org_admin', 'branch_manager', 'sales_executive')
ON CONFLICT (role_id, permission) DO NOTHING;
