import { ConflictException } from '@nestjs/common';
import { releaseStock, reserveStock, schema, type Transaction } from '@paint/db';
import type { InsufficientStockRefusal } from '@paint/shared';
import { and, asc, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';

const { stockBalances, stockReservations } = schema;

/** Thousandths, so quantities (at most 3 decimals) add up exactly. */
const milli = (quantity: number) => Math.round(quantity * 1000);

/** What an order line should hold, and where. */
export interface Hold {
  readonly line: { readonly id: string; readonly lineNo: number; readonly variantId: string };
  readonly storeId: string;
  /** The whole amount to hold; 0 holds nothing. */
  readonly quantity: number;
}

/** What each line holds now (open reservations), by line id. */
export async function heldByLine(
  tx: Transaction,
  lineIds: readonly string[],
): Promise<(lineId: string) => number> {
  const rows = await tx
    .select({
      lineId: stockReservations.orderLineId,
      quantity: stockReservations.quantity,
    })
    .from(stockReservations)
    .where(
      and(
        inArray(stockReservations.orderLineId, [...lineIds]),
        sql`${stockReservations.status} = 'open'`,
      ),
    );
  return (lineId) => rows.find((row) => row.lineId === lineId)?.quantity ?? 0;
}

/**
 * Makes each line hold exactly `quantity` at `storeId` (spec §4.3): gives
 * back what it held, then reserves the new amount. Refused as a whole, line
 * by line with what is short (InsufficientStockRefusal), when a store has not
 * got it; the caller's transaction then rolls back the release too.
 */
export async function holdStock(
  tx: Transaction,
  auth: AuthContext,
  holds: readonly Hold[],
): Promise<void> {
  await releaseStock(
    tx,
    holds.map((hold) => ({ orderLineId: hold.line.id })),
  );
  const wanted = holds.filter((hold) => hold.quantity > 0);
  if (wanted.length === 0) return;
  const balances = await tx
    .select({
      storeId: stockBalances.storeId,
      variantId: stockBalances.variantId,
      available: sql<number>`${stockBalances.onHand} - ${stockBalances.reserved}`.mapWith(Number),
    })
    .from(stockBalances)
    .where(
      and(
        inArray(stockBalances.storeId, [...new Set(wanted.map((hold) => hold.storeId))]),
        inArray(stockBalances.variantId, [...new Set(wanted.map((hold) => hold.line.variantId))]),
      ),
    )
    .orderBy(asc(stockBalances.storeId), asc(stockBalances.variantId))
    .for('update');
  // Lines share a store's stock in line order; each one short is reported.
  const left = new Map(
    balances.map((balance) => [
      `${balance.storeId}:${balance.variantId}`,
      milli(balance.available),
    ]),
  );
  const short: InsufficientStockRefusal['lines'][number][] = [];
  for (const hold of [...wanted].sort((a, b) => a.line.lineNo - b.line.lineNo)) {
    const key = `${hold.storeId}:${hold.line.variantId}`;
    const available = left.get(key) ?? 0;
    if (milli(hold.quantity) > available) {
      short.push({
        lineId: hold.line.id,
        lineNo: hold.line.lineNo,
        storeId: hold.storeId,
        wantedQuantity: hold.quantity,
        availableQuantity: Math.max(0, available) / 1000,
      });
    }
    left.set(key, available - milli(hold.quantity));
  }
  if (short.length > 0) {
    const refusal: InsufficientStockRefusal = {
      statusCode: 409,
      code: 'insufficient_stock',
      message: `Not enough stock to hold line ${short.map((line) => String(line.lineNo)).join(', ')}`,
      lines: short,
    };
    throw new ConflictException(refusal);
  }
  await reserveStock(
    tx,
    wanted.map((hold) => ({
      organizationId: auth.organization.id,
      storeId: hold.storeId,
      variantId: hold.line.variantId,
      orderLineId: hold.line.id,
      quantity: hold.quantity,
      createdByMemberId: auth.memberId,
    })),
  );
}
