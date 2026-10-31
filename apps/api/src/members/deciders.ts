import { schema, type Transaction } from '@paint/db';
import type { Permission } from '@paint/shared';
import { and, eq, ne, sql } from 'drizzle-orm';
import { holdsPermission } from './member-permission.js';

const { organizationMembers } = schema;

/** Active team members, not platform support here on a grant. */
const working = () =>
  and(eq(organizationMembers.isActive, true), eq(organizationMembers.isSupport, false));

/**
 * Whether another active member of the business holds `permission`: when nobody
 * else does, a one-person shop may decide what it asked for itself.
 */
export async function someoneElseHolds(
  tx: Transaction,
  member: { readonly organizationId: string; readonly memberId: string },
  permission: Permission,
): Promise<boolean> {
  const [row] = await tx
    .select({ one: sql`1` })
    .from(organizationMembers)
    .where(
      and(
        eq(organizationMembers.organizationId, member.organizationId),
        working(),
        ne(organizationMembers.id, member.memberId),
        holdsPermission(tx, permission),
      ),
    )
    .limit(1);
  return row !== undefined;
}
