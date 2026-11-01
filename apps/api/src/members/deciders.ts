import { schema, type Transaction } from '@paint/db';
import type { Permission } from '@paint/shared';
import { and, eq, exists, ne, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { holdsPermission } from './member-permission.js';

const { memberStores, organizationMembers } = schema;

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

/**
 * True for a store (the column) with a buyer of its own: an active member
 * assigned to it (not one who works at every store, like the owner) holding
 * purchasing:manage. Low stock goes to whoever buys at the store; at a store
 * without its own buyer, also to who manages its stock, so nothing goes unnoticed.
 */
export function hasOwnBuyer(tx: Transaction, storeId: AnyColumn): SQL {
  return exists(
    tx
      .select({ one: sql`1` })
      .from(organizationMembers)
      .innerJoin(memberStores, eq(memberStores.memberId, organizationMembers.id))
      .where(
        and(
          eq(memberStores.storeId, storeId),
          working(),
          eq(organizationMembers.allStores, false),
          holdsPermission(tx, 'purchasing:manage'),
        ),
      ),
  );
}
