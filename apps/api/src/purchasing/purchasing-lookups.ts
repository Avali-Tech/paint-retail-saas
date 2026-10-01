import { BadRequestException, NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import { canAccessStore } from '@paint/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';

const { parties, partyRoles, productVariants, stores } = schema;

export interface PartySummary {
  readonly id: string;
  readonly name: string;
  readonly gstin: string | null;
}

/** An active party with the supplier role; 404 otherwise. */
export async function requireSupplier(tx: Transaction, partyId: string): Promise<PartySummary> {
  const [row] = await tx
    .select({ id: parties.id, name: parties.displayName, gstin: parties.gstin })
    .from(parties)
    .innerJoin(partyRoles, and(eq(partyRoles.partyId, parties.id), eq(partyRoles.role, 'supplier')))
    .where(and(eq(parties.id, partyId), eq(parties.isActive, true)));
  if (!row) throw new NotFoundException('Supplier not found');
  return row;
}

/** An active store the member works at; 404 otherwise. */
export async function requireStore(
  tx: Transaction,
  auth: AuthContext,
  storeId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: stores.id })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true)));
  if (!row || !canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
}

/** Every variant exists; 400 otherwise. */
export async function requireVariants(tx: Transaction, variantIds: string[]): Promise<void> {
  const found = await tx
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds));
  if (found.length !== variantIds.length) throw new BadRequestException('Unknown product variant');
}
