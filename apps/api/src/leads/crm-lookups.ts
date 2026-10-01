import { BadRequestException, NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { canAccessStore, type Permission } from '@paint/shared';
import { and, eq, inArray, or, type AnyColumn, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { canSeeParty } from '../parties/party-access.js';

const { categories, memberStores, organizationMembers, parties, rolePermissions, stores } = schema;

/** An active store the member works at; 404 otherwise. */
export async function requireStore(
  tx: Transaction,
  auth: AuthContext,
  storeId: string,
): Promise<void> {
  const [store] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true)));
  if (!store || !canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
}

/** An active party the member can see; 400 otherwise (it is an input, not the resource). */
export async function requireParty(
  tx: Transaction,
  auth: AuthContext,
  partyId: string,
  label = 'party',
): Promise<void> {
  const [party] = await tx
    .select({ homeStoreId: parties.homeStoreId })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.isActive, true)));
  if (!party || !canSeeParty(auth, party)) throw new BadRequestException(`Unknown ${label}`);
}

export async function requireCategory(tx: Transaction, categoryId: string): Promise<void> {
  const [category] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.id, categoryId));
  if (!category) throw new BadRequestException('Unknown category');
}

/** An active member who works at the store and has the permission (leads by default); 400 otherwise. */
export async function requireSalesperson(
  tx: Transaction,
  memberId: string,
  storeId: string,
  permission: Permission = 'leads:manage',
): Promise<void> {
  const [member] = await tx
    .select({ id: organizationMembers.id })
    .from(organizationMembers)
    .innerJoin(
      rolePermissions,
      and(
        eq(rolePermissions.roleId, organizationMembers.roleId),
        eq(rolePermissions.permission, permission),
      ),
    )
    .where(
      and(
        eq(organizationMembers.id, memberId),
        eq(organizationMembers.isActive, true),
        or(
          eq(organizationMembers.allStores, true),
          inArray(
            organizationMembers.id,
            tx
              .select({ id: memberStores.memberId })
              .from(memberStores)
              .where(eq(memberStores.storeId, storeId)),
          ),
        ),
      ),
    );
  if (!member) {
    throw new BadRequestException(
      `Choose someone who works at this store and handles ${permission.slice(0, permission.indexOf(':'))}`,
    );
  }
}

/** Limits a list to the member's stores, or one of them. */
export function storeScope(
  auth: AuthContext,
  column: AnyColumn,
  storeId?: string,
): SQL | undefined {
  if (storeId) {
    if (!canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
    return eq(column, storeId);
  }
  return auth.allStores ? undefined : inArray(column, [...auth.storeIds]);
}

/** Filters by assignee: a member id or "me". */
export function assigneeFilter(
  auth: AuthContext,
  column: AnyColumn,
  assignedTo: string | undefined,
): SQL | undefined {
  if (assignedTo === undefined) return undefined;
  return eq(column, assignedTo === 'me' ? auth.memberId : assignedTo);
}
