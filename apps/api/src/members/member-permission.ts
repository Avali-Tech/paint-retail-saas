import { schema, type Transaction } from '@paint/db';
import { isPermission, type Permission, type PermissionExceptions } from '@paint/shared';
import { and, eq, exists, sql, type SQL } from 'drizzle-orm';

const { memberPermissionExceptions, organizationMembers, rolePermissions } = schema;

/**
 * Filter on organization_members: the member holds `permission` through their
 * role or a grant of their own, and none of their exceptions denies it. The
 * SQL form of effectivePermissions in @paint/shared.
 */
export function holdsPermission(tx: Transaction, permission: Permission): SQL {
  const exception = (granted: boolean) =>
    exists(
      tx
        .select({ one: sql`1` })
        .from(memberPermissionExceptions)
        .where(
          and(
            eq(memberPermissionExceptions.memberId, organizationMembers.id),
            eq(memberPermissionExceptions.permission, permission),
            eq(memberPermissionExceptions.granted, granted),
          ),
        ),
    );
  const fromRole = exists(
    tx
      .select({ one: sql`1` })
      .from(rolePermissions)
      .where(
        and(
          eq(rolePermissions.roleId, organizationMembers.roleId),
          eq(rolePermissions.permission, permission),
        ),
      ),
  );
  return sql`(${fromRole} or ${exception(true)}) and not ${exception(false)}`;
}

/** A member's exception rows as the permissions granted and denied, each sorted. */
export function toExceptions(
  rows: readonly { readonly permission: string; readonly granted: boolean }[],
): PermissionExceptions {
  const pick = (granted: boolean) =>
    rows
      .filter((row) => row.granted === granted)
      .map((row) => row.permission)
      .filter(isPermission)
      .sort();
  return { granted: pick(true), denied: pick(false) };
}
