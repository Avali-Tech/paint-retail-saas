import { schema } from '@paint/db';
import { canAccessStore } from '@paint/shared';
import { NotFoundException } from '@nestjs/common';
import { inArray, type AnyColumn, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';

type StoreRow = typeof schema.stores.$inferSelect;

export interface StoreSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export const storeSummary = (store: StoreRow): StoreSummary => ({
  id: store.id,
  code: store.code,
  name: store.name,
});

export const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** Line value in paise, or null when the cost is unknown. */
export const lineValue = (quantity: number, unitCostPaise: number | null) =>
  unitCostPaise === null ? null : Math.round(quantity * unitCostPaise);

export const totalValue = (values: (number | null)[]) =>
  values.reduce<number>((total, value) => total + Number(value), 0);

/** Limits a list to the member's stores, or to one of them. */
export function storeScope(
  auth: AuthContext,
  column: AnyColumn,
  storeId?: string,
): SQL | undefined {
  if (storeId) {
    if (!canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
    return inArray(column, [storeId]);
  }
  return auth.allStores ? undefined : inArray(column, [...auth.storeIds]);
}
