-- Two-factor sign-in (TOTP).

-- 1. Authenticator secrets, recovery codes and pending sign-ins are for
-- sign-in code only, never for tenants.
REVOKE ALL ON user_totp, user_recovery_codes, two_factor_challenges FROM app_tenant;--> statement-breakpoint

-- 2. Businesses may turn the requirement for owners and admins on or off.
GRANT UPDATE (two_factor_required) ON organizations TO app_tenant;--> statement-breakpoint

-- 3. Audit log: the requirement, and owners resetting a member's two-factor sign-in.
DROP TRIGGER audit_organization_plan ON organizations;--> statement-breakpoint
CREATE TRIGGER audit_organization_plan
AFTER UPDATE ON organizations
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'plan', 'feature_flags', 'suspended_at', 'suspend_reason', 'two_factor_required');--> statement-breakpoint

DROP TRIGGER audit_member_access ON organization_members;--> statement-breakpoint
CREATE TRIGGER audit_member_access
AFTER INSERT OR UPDATE OR DELETE ON organization_members
FOR EACH ROW EXECUTE FUNCTION audit_row_change('id', 'role_id', 'all_stores', 'is_active', 'two_factor_reset_at');
