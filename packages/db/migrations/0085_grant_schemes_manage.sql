-- Data migration: give existing organisations' Owner and Organization Admin system roles
-- the new schemes:manage permission (brand schemes, slabs, received benefits and claims,
-- P2-M33; spec §3.8), matching SYSTEM_ROLES in @paint/shared. Viewing schemes needs
-- purchasing:read, which the roles already have. Custom roles are left for owners to
-- adjust. Safe to re-run.
INSERT INTO role_permissions (organization_id, role_id, permission)
SELECT r.organization_id, r.id, 'schemes:manage'
FROM roles r
WHERE r.is_system AND r.key IN ('owner', 'org_admin')
ON CONFLICT (role_id, permission) DO NOTHING;
