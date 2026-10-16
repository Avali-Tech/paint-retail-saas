import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client.js';
import { isCheckViolation } from './errors.js';
import { stockBalances, stockLedger, stockReservations, type stockMovementType } from './schema.js';

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

/** A movement for postStockMovementsInBulk; `createdAt` back-dates it (bulk data loads). */
export interface BulkStockMovement extends StockMovement {
  readonly createdAt?: Date;
}

/** Rows per INSERT, well inside PostgreSQL's 65,535 parameters per statement. */
const BULK_CHUNK = 4_000;

/** Stock in thousandths, so quantities (at most 3 decimals) add exactly. */
const toMilli = (quantity: number) => Math.round(quantity * 1000);

/**
 * The weighted-average cost per unit (paise) after a costed receipt of
 * `quantityMilli` thousandths at `costPaise`, onto `onHandMilli` at `averagePaise`:
 * the receipt's cost when there was no cost or no stock before, else
 * round((on hand × average + quantity × cost) / (on hand + quantity)), half up,
 * exactly as postStockMovements computes it in PostgreSQL. Brand profitability
 * replays the ledger with it to find the average cost on any past day.
 */
export function nextAverageCost(
  onHandMilli: bigint,
  averagePaise: bigint | null,
  quantityMilli: bigint,
  costPaise: bigint,
): bigint {
  if (averagePaise === null || onHandMilli <= 0n) return costPaise;
  const value = onHandMilli * averagePaise + quantityMilli * costPaise;
  const onHand = onHandMilli + quantityMilli;
  return (2n * value + onHand) / (2n * onHand);
}

interface BulkBalance {
  readonly organizationId: string;
  readonly storeId: string;
  readonly variantId: string;
  onHand: number;
  reserved: number;
  avgCostPaise: bigint | null;
}

/**
 * postStockMovements for thousands of movements at once (data loads, such as
 * the large demo): the same ledger entries, balances and weighted-average cost,
 * with the same refusals, in a handful of statements instead of three per
 * movement. Movements apply in the order given for each store and product.
 * The balances touched are locked first, so concurrent movements wait.
 */
export async function postStockMovementsInBulk(
  tx: Transaction,
  movements: readonly BulkStockMovement[],
): Promise<void> {
  const balances = new Map<string, BulkBalance>();
  const balanceOf = (movement: StockMovement): BulkBalance => {
    const key = `${movement.storeId}:${movement.variantId}`;
    let balance = balances.get(key);
    if (balance === undefined) {
      balance = {
        organizationId: movement.organizationId,
        storeId: movement.storeId,
        variantId: movement.variantId,
        onHand: 0,
        reserved: 0,
        avgCostPaise: null,
      };
      balances.set(key, balance);
    }
    return balance;
  };
  for (const movement of movements) balanceOf(movement);
  if (balances.size === 0) return;
  // A fixed order, as in postStockMovements, so concurrent loads cannot deadlock.
  const touched = [...balances.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, balance]) => balance);

  // Make sure every balance row exists, then lock them all, as postStockMovements does one by one.
  for (const chunk of chunks(touched)) {
    await tx
      .insert(stockBalances)
      .values(
        chunk.map(({ organizationId, storeId, variantId }) => ({
          organizationId,
          storeId,
          variantId,
        })),
      )
      .onConflictDoNothing();
  }
  const locked = await tx.execute<{
    organization_id: string;
    store_id: string;
    variant_id: string;
    on_hand: string;
    reserved: string;
    avg_cost_paise: string | null;
  }>(sql`
    select b.organization_id, b.store_id, b.variant_id, b.on_hand, b.reserved, b.avg_cost_paise
    from ${stockBalances} b
    join unnest(
      ${`{${touched.map((balance) => balance.storeId).join(',')}}`}::uuid[],
      ${`{${touched.map((balance) => balance.variantId).join(',')}}`}::uuid[]
    ) as k(store_id, variant_id) on k.store_id = b.store_id and k.variant_id = b.variant_id
    order by b.store_id, b.variant_id
    for update of b
  `);
  for (const row of locked.rows) {
    const balance = balanceOf({
      organizationId: row.organization_id,
      storeId: row.store_id,
      variantId: row.variant_id,
      movementType: 'adjustment',
      quantity: 0,
    });
    balance.onHand = toMilli(Number(row.on_hand));
    balance.reserved = toMilli(Number(row.reserved));
    balance.avgCostPaise = row.avg_cost_paise === null ? null : BigInt(row.avg_cost_paise);
  }

  for (const movement of movements) {
    const balance = balanceOf(movement);
    const quantity = toMilli(movement.quantity);
    const onHand = balance.onHand + quantity;
    if (onHand < balance.reserved) {
      throw new InsufficientStockError(movement.storeId, movement.variantId);
    }
    const cost = movement.quantity > 0 ? (movement.unitCostPaise ?? null) : null;
    if (cost !== null) {
      balance.avgCostPaise = nextAverageCost(
        BigInt(balance.onHand),
        balance.avgCostPaise,
        BigInt(quantity),
        BigInt(cost),
      );
    }
    balance.onHand = onHand;
  }

  for (const chunk of chunks(movements)) await tx.insert(stockLedger).values(chunk);
  for (const chunk of chunks(touched)) {
    await tx
      .insert(stockBalances)
      .values(
        chunk.map((balance) => ({
          organizationId: balance.organizationId,
          storeId: balance.storeId,
          variantId: balance.variantId,
          onHand: balance.onHand / 1000,
          avgCostPaise: balance.avgCostPaise === null ? null : Number(balance.avgCostPaise),
        })),
      )
      .onConflictDoUpdate({
        target: [stockBalances.storeId, stockBalances.variantId],
        set: {
          onHand: sql`excluded.on_hand`,
          avgCostPaise: sql`excluded.avg_cost_paise`,
          updatedAt: sql`now()`,
        },
      });
  }
}

function* chunks<T>(items: readonly T[]): Generator<T[]> {
  for (let start = 0; start < items.length; start += BULK_CHUNK) {
    yield items.slice(start, start + BULK_CHUNK);
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

/** Stock to hold for an order line at a store (spec §4.3). */
export interface StockReservationRequest {
  readonly organizationId: string;
  readonly storeId: string;
  readonly variantId: string;
  readonly orderLineId: string;
  /** More than zero, at most 3 decimals. */
  readonly quantity: number;
  readonly createdByMemberId?: string;
}

/**
 * Holds stock for order lines: adds each quantity to the store's
 * `stock_balances.reserved` and records an open reservation, in the caller's
 * transaction. A line holds at most one open reservation (release it first to
 * change it). Balances are touched in a fixed order, as postStockMovements does.
 *
 * Throws InsufficientStockError when a store has less available (on hand less
 * already reserved) than asked; the caller's transaction then rolls back.
 * Returns the reservation ids, in the order given.
 */
export async function reserveStock(
  tx: Transaction,
  requests: readonly StockReservationRequest[],
): Promise<string[]> {
  const ids = new Map<StockReservationRequest, string>();
  const ordered = [...requests].sort((a, b) =>
    `${a.storeId}:${a.variantId}`.localeCompare(`${b.storeId}:${b.variantId}`),
  );
  for (const request of ordered) {
    await tx
      .insert(stockBalances)
      .values({
        organizationId: request.organizationId,
        storeId: request.storeId,
        variantId: request.variantId,
      })
      .onConflictDoNothing();
    try {
      await tx
        .update(stockBalances)
        .set({
          reserved: sql`${stockBalances.reserved} + ${request.quantity}`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(stockBalances.storeId, request.storeId),
            eq(stockBalances.variantId, request.variantId),
          ),
        );
    } catch (error) {
      if (isCheckViolation(error, ['stock_balances_reserved_within_on_hand'])) {
        throw new InsufficientStockError(request.storeId, request.variantId);
      }
      throw error;
    }
    const [row] = (await tx
      .insert(stockReservations)
      .values({
        organizationId: request.organizationId,
        storeId: request.storeId,
        variantId: request.variantId,
        orderLineId: request.orderLineId,
        quantity: request.quantity,
        createdByMemberId: request.createdByMemberId,
      })
      .returning({ id: stockReservations.id })) as [{ id: string }];
    ids.set(request, row.id);
  }
  return requests.map((request) => String(ids.get(request)));
}

/** What a release gives back: part or all of an order line's open reservation. */
export interface StockReservationRelease {
  readonly orderLineId: string;
  /** Defaults to all of it; more than is held releases what is held. */
  readonly quantity?: number;
  /** Set when the goods are going out (an invoice or dispatch): the reservation is consumed. */
  readonly consumedBy?: { readonly type: 'tax_document' | 'dispatch'; readonly id: string };
}

/**
 * Gives back held stock, in the caller's transaction: takes the quantity off
 * `stock_balances.reserved` and closes it in the reservations, `consumed` when
 * the goods are going out, `released` otherwise. Part of a reservation is
 * split off into a closed row of its own; the rest stays open. Returns the
 * quantity actually released per request (0 when the line holds nothing).
 */
export async function releaseStock(
  tx: Transaction,
  releases: readonly StockReservationRelease[],
): Promise<number[]> {
  if (releases.length === 0) return [];
  // Lock every open reservation involved first, then work in balance order, so
  // concurrent releases cannot deadlock. A line named twice is read afresh each time.
  const lineIds = [...new Set(releases.map((release) => release.orderLineId))];
  const locked = await tx
    .select({
      orderLineId: stockReservations.orderLineId,
      storeId: stockReservations.storeId,
      variantId: stockReservations.variantId,
    })
    .from(stockReservations)
    .where(
      and(inArray(stockReservations.orderLineId, lineIds), eq(stockReservations.status, 'open')),
    )
    .orderBy(asc(stockReservations.storeId), asc(stockReservations.variantId))
    .for('update');
  const keyOf = (release: StockReservationRelease) => {
    const row = locked.find((candidate) => candidate.orderLineId === release.orderLineId);
    return row ? `${row.storeId}:${row.variantId}` : '';
  };
  const released = new Map<StockReservationRelease, number>();
  const ordered = [...releases].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
  for (const release of ordered) {
    const [open] = await tx
      .select()
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.orderLineId, release.orderLineId),
          eq(stockReservations.status, 'open'),
        ),
      );
    if (open === undefined) {
      released.set(release, 0);
      continue;
    }
    const quantity = Math.min(toMilli(release.quantity ?? open.quantity), toMilli(open.quantity));
    released.set(release, quantity / 1000);
    if (quantity <= 0) continue;
    await tx
      .update(stockBalances)
      .set({
        reserved: sql`${stockBalances.reserved} - ${quantity / 1000}`,
        updatedAt: sql`now()`,
      })
      .where(
        and(eq(stockBalances.storeId, open.storeId), eq(stockBalances.variantId, open.variantId)),
      );
    const closed = {
      status: release.consumedBy ? ('consumed' as const) : ('released' as const),
      consumedByType: release.consumedBy?.type ?? null,
      consumedById: release.consumedBy?.id ?? null,
      closedAt: sql`clock_timestamp()`,
    };
    if (quantity === toMilli(open.quantity)) {
      await tx.update(stockReservations).set(closed).where(eq(stockReservations.id, open.id));
    } else {
      await tx
        .update(stockReservations)
        .set({ quantity: sql`${stockReservations.quantity} - ${quantity / 1000}` })
        .where(eq(stockReservations.id, open.id));
      await tx.insert(stockReservations).values({
        organizationId: open.organizationId,
        storeId: open.storeId,
        variantId: open.variantId,
        orderLineId: open.orderLineId,
        quantity: quantity / 1000,
        createdByMemberId: open.createdByMemberId,
        ...closed,
      });
    }
  }
  return releases.map((release) => Number(released.get(release)));
}

export interface ReservationMismatch {
  readonly organizationId: string;
  readonly storeId: string;
  readonly variantId: string;
  readonly reserved: number;
  readonly openReservations: number;
}

/**
 * Balances whose `reserved` differs from the sum of their open reservations
 * (spec §3.3). Should always be empty; run it nightly with findStockMismatches.
 * Outside tenant scope it checks every organisation.
 */
export async function findReservationMismatches(
  db: Database | Transaction,
): Promise<ReservationMismatch[]> {
  const result = await db.execute<{
    organization_id: string;
    store_id: string;
    variant_id: string;
    reserved: string;
    open_total: string;
  }>(sql`
    select
      coalesce(b.organization_id, r.organization_id) as organization_id,
      coalesce(b.store_id, r.store_id) as store_id,
      coalesce(b.variant_id, r.variant_id) as variant_id,
      coalesce(b.reserved, 0) as reserved,
      coalesce(r.total, 0) as open_total
    from ${stockBalances} b
    full outer join (
      select organization_id, store_id, variant_id, sum(quantity) as total
      from ${stockReservations}
      where status = 'open'
      group by organization_id, store_id, variant_id
    ) r on r.store_id = b.store_id and r.variant_id = b.variant_id
    where coalesce(b.reserved, 0) <> coalesce(r.total, 0)
    order by 1, 2, 3
  `);
  return result.rows.map((row) => ({
    organizationId: row.organization_id,
    storeId: row.store_id,
    variantId: row.variant_id,
    reserved: Number(row.reserved),
    openReservations: Number(row.open_total),
  }));
}
