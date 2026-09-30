import { and, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client.js';
import { isCheckViolation } from './errors.js';
import { stockBalances, stockLedger, type stockMovementType } from './schema.js';

export type StockMovementType = (typeof stockMovementType.enumValues)[number];

export interface StockMovement {
  readonly organizationId: string;
  readonly storeId: string;
  readonly variantId: string;
  readonly movementType: StockMovementType;
  /** Positive = stock in, negative = stock out. At most 3 decimals. */
  readonly quantity: number;
  /** Cost per unit in paise, for incoming stock. */
  readonly unitCostPaise?: number | null;
  readonly referenceType?: string;
  readonly referenceId?: string;
  readonly note?: string;
  readonly createdByMemberId?: string;
}

/** A movement would take a store's available stock of a variant below zero. */
export class InsufficientStockError extends Error {
  override readonly name = 'InsufficientStockError';

  constructor(
    readonly storeId: string,
    readonly variantId: string,
  ) {
    super('Not enough stock for this movement');
  }
}

/**
 * The only way stock changes: appends each movement to the ledger and updates
 * the balance in the same transaction. Arithmetic runs in PostgreSQL on exact
 * decimals. Incoming costed stock updates the weighted-average cost.
 *
 * Throws InsufficientStockError when stock would go negative; the caller's
 * transaction then rolls back, so nothing is written.
 */
export async function postStockMovements(
  tx: Transaction,
  movements: readonly StockMovement[],
): Promise<void> {
  // Touch balances in a fixed order so concurrent transactions cannot deadlock.
  const ordered = [...movements].sort((a, b) =>
    `${a.storeId}:${a.variantId}`.localeCompare(`${b.storeId}:${b.variantId}`),
  );
  for (const movement of ordered) {
    await tx.insert(stockLedger).values(movement);
    // Make sure the balance row exists, then add to it. (A single INSERT ... ON
    // CONFLICT would test the not-negative check against the raw movement, e.g.
    // -2, before adding it to the existing balance.) The UPDATE locks the row,
    // so concurrent movements on the same stock are applied one at a time.
    await tx
      .insert(stockBalances)
      .values({
        organizationId: movement.organizationId,
        storeId: movement.storeId,
        variantId: movement.variantId,
      })
      .onConflictDoNothing();
    const incomingCost = movement.quantity > 0 ? (movement.unitCostPaise ?? null) : null;
    try {
      await tx
        .update(stockBalances)
        .set({
          onHand: sql`${stockBalances.onHand} + ${movement.quantity}`,
          avgCostPaise: sql`case
            when ${incomingCost}::bigint is null then ${stockBalances.avgCostPaise}
            when ${stockBalances.avgCostPaise} is null or ${stockBalances.onHand} <= 0
              then ${incomingCost}::bigint
            else round(
              (${stockBalances.onHand} * ${stockBalances.avgCostPaise}
                + ${movement.quantity}::numeric * ${incomingCost}::bigint)
              / (${stockBalances.onHand} + ${movement.quantity}::numeric)
            )::bigint
          end`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(stockBalances.storeId, movement.storeId),
            eq(stockBalances.variantId, movement.variantId),
          ),
        );
    } catch (error) {
      // Below zero, or below what is reserved for orders: not enough available stock.
      if (
        isCheckViolation(error, [
          'stock_balances_on_hand_not_negative',
          'stock_balances_reserved_within_on_hand',
        ])
      ) {
        throw new InsufficientStockError(movement.storeId, movement.variantId);
      }
      throw error;
    }
  }
}

export interface StockMismatch {
  readonly organizationId: string;
  readonly storeId: string;
  readonly variantId: string;
  readonly onHand: number;
  readonly ledgerTotal: number;
}

/**
 * Balances that disagree with the sum of their ledger entries. Should always be
 * empty; run it nightly and alert on anything found. Outside tenant scope it
 * checks every organisation.
 */
export async function findStockMismatches(db: Database | Transaction): Promise<StockMismatch[]> {
  const result = await db.execute<{
    organization_id: string;
    store_id: string;
    variant_id: string;
    on_hand: string;
    ledger_total: string;
  }>(sql`
    select
      coalesce(b.organization_id, l.organization_id) as organization_id,
      coalesce(b.store_id, l.store_id) as store_id,
      coalesce(b.variant_id, l.variant_id) as variant_id,
      coalesce(b.on_hand, 0) as on_hand,
      coalesce(l.total, 0) as ledger_total
    from ${stockBalances} b
    full outer join (
      select organization_id, store_id, variant_id, sum(quantity) as total
      from ${stockLedger}
      group by organization_id, store_id, variant_id
    ) l on l.store_id = b.store_id and l.variant_id = b.variant_id
    where coalesce(b.on_hand, 0) <> coalesce(l.total, 0)
    order by 1, 2, 3
  `);
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    storeId: row.store_id,
    variantId: row.variant_id,
    onHand: Number(row.on_hand),
    ledgerTotal: Number(row.ledger_total),
  }));
}
