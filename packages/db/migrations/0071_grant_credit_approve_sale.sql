-- Data migration: give existing organisations' standard roles the new
-- credit:approve_sale permission (approving a sale past the credit rules at
-- manager level, P2-M09), matching SYSTEM_ROLES in @paint/shared. Custom roles
-- are left for owners to adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, 'credit:approve_sale'
FROM roles r
WHERE r.is_system AND r.key IN ('owner', 'org_admin', 'branch_manager')
ON CONFLICT (role_id, permission) DO NOTHING;
