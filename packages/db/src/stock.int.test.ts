import { createIsolatedDatabase, type TestDatabase } from '@paint/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import {
  InsufficientStockError,
  createDatabase,
  findStockMismatches,
  migrateDatabase,
  postStockMovements,
  postStockMovementsInBulk,
  schema,
  withTenant,
  type DatabaseConnection,
  type StockMovement,
} from './index.js';

const { brands, organizations, productVariants, products, stockBalances, stockLedger, stores } =
  schema;

let database: TestDatabase;
let connection: DatabaseConnection;
let org: string;
let otherOrg: string;
let hyd: string;
let pune: string;
let otherStore: string;
let apex20: string;
let colorant: string;

async function failureMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const { message, cause } = error as Error;
    return `${message} ${cause instanceof Error ? cause.message : ''}`;
  }
  throw new Error('Expected the query to fail, but it succeeded');
}

function id(rows: { id: string }[]): string {
  const [row] = rows;
  if (!row) throw new Error('Expected a row');
  return row.id;
}

type Poster = typeof postStockMovements;

/** Posts movements for `org` in one tenant-scoped transaction, with `implementation`. */
const postWith =
  (implementation: Poster) =>
  (movements: Omit<StockMovement, 'organizationId'>[], organizationId = org) =>
    withTenant(connection.db, organizationId, (tx) =>
      implementation(
        tx,
        movements.map((movement) => ({ organizationId, ...movement })),
      ),
    );
const post = postWith(postStockMovements);

async function balance(storeId: string, variantId: string) {
  const [row] = await connection.db
    .select()
    .from(stockBalances)
    .where(and(eq(stockBalances.storeId, storeId), eq(stockBalances.variantId, variantId)));
  return row;
}

beforeAll(async () => {
  database = await createIsolatedDatabase(inject('databaseUrl'));
  await migrateDatabase(database.connectionString);
  connection = createDatabase(database.connectionString);
  const { db } = connection;
  org = id(await db.insert(organizations).values({ name: 'ABC Paints' }).returning());
  otherOrg = id(await db.insert(organizations).values({ name: 'XYZ Paints' }).returning());
  hyd = id(
    await db.insert(stores).values({ organizationId: org, name: 'HYD', code: 'HYD' }).returning(),
  );
  pune = id(
    await db.insert(stores).values({ organizationId: org, name: 'PUN', code: 'PUN' }).returning(),
  );
  otherStore = id(
    await db.insert(stores).values({ organizationId: otherOrg, name: 'X', code: 'X' }).returning(),
  );
  const brand = id(
    await db.insert(brands).values({ organizationId: org, name: 'Asian Paints' }).returning(),
  );
  const product = id(
    await db
      .insert(products)
      .values({
        organizationId: org,
        brandId: brand,
        name: 'Apex',
        type: 'exterior_paint',
        hsnCode: '3209',
        gstRateBps: 1800,
      })
      .returning(),
  );
  apex20 = id(
    await db
      .insert(productVariants)
      .values({ organizationId: org, productId: product, sku: 'AP-20L', packSize: 20, unit: 'l' })
      .returning(),
  );
  colorant = id(
    await db
      .insert(productVariants)
      .values({
        organizationId: org,
        productId: product,
        sku: 'CLR-1L',
        packSize: 1000,
        unit: 'ml',
      })
      .returning(),
  );
});

afterAll(async () => {
  await connection.close();
  await database.stop();
});

// The ledger is append-only, so each test uses its own store to start from zero.
let store: string;
beforeEach(async () => {
  store = id(
    await connection.db
      .insert(stores)
      .values({
        organizationId: org,
        name: 'Test',
        code: `T${String(Date.now()).slice(-8)}${String(Math.random()).slice(2, 5)}`,
      })
      .returning(),
  );
});

// The bulk path must behave exactly like the one-by-one path, so both run the same tests.
describe.each([
  ['postStockMovements', postStockMovements],
  ['postStockMovementsInBulk', postStockMovementsInBulk],
] as const)('%s', (_name, implementation) => {
  const post = postWith(implementation);

  it('records opening stock in the ledger and the balance', async () => {
    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'opening',
        quantity: 10,
        unitCostPaise: 1_000_000,
      },
    ]);

    const entries = await connection.db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.storeId, store));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      movementType: 'opening',
      quantity: 10,
      unitCostPaise: 1_000_000,
    });
    expect(await balance(store, apex20)).toMatchObject({
      onHand: 10,
      reserved: 0,
      avgCostPaise: 1_000_000,
    });
  });

  it('keeps a weighted-average cost across receipts, rounded to the paisa', async () => {
    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'opening',
        quantity: 10,
        unitCostPaise: 10_000,
      },
    ]);
    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'purchase_receipt',
        quantity: 10,
        unitCostPaise: 20_000,
      },
    ]);
    expect((await balance(store, apex20))?.avgCostPaise).toBe(15_000);

    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'purchase_receipt',
        quantity: 3,
        unitCostPaise: 15_001,
      },
    ]);
    // (20 × 15000 + 3 × 15001) / 23 = 15000.13… → 15000
    expect((await balance(store, apex20))?.avgCostPaise).toBe(15_000);
  });

  it('leaves the average cost alone for stock going out or arriving without a cost', async () => {
    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'opening',
        quantity: 10,
        unitCostPaise: 10_000,
      },
    ]);
    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'damage',
        quantity: -2,
        unitCostPaise: 99,
      },
    ]);
    await post([{ storeId: store, variantId: apex20, movementType: 'adjustment', quantity: 1 }]);

    expect(await balance(store, apex20)).toMatchObject({ onHand: 9, avgCostPaise: 10_000 });
  });

  it('starts the average afresh once stock has run out', async () => {
    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'opening',
        quantity: 2,
        unitCostPaise: 10_000,
      },
    ]);
    await post([{ storeId: store, variantId: apex20, movementType: 'sale', quantity: -2 }]);
    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'purchase_receipt',
        quantity: 5,
        unitCostPaise: 12_000,
      },
    ]);

    expect(await balance(store, apex20)).toMatchObject({ onHand: 5, avgCostPaise: 12_000 });
  });

  it('has no cost until costed stock arrives', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 4 }]);
    expect((await balance(store, apex20))?.avgCostPaise).toBeNull();

    await post([
      {
        storeId: store,
        variantId: apex20,
        movementType: 'purchase_receipt',
        quantity: 1,
        unitCostPaise: 9_000,
      },
    ]);
    expect((await balance(store, apex20))?.avgCostPaise).toBe(9_000);
  });

  it('adds fractional quantities exactly', async () => {
    await post([
      { storeId: store, variantId: colorant, movementType: 'opening', quantity: 0.1 },
      { storeId: store, variantId: colorant, movementType: 'adjustment', quantity: 0.2 },
    ]);

    expect((await balance(store, colorant))?.onHand).toBe(0.3);
  });

  it('refuses to take stock below zero, and writes nothing from that transaction', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 3 }]);

    await expect(
      post([
        { storeId: store, variantId: colorant, movementType: 'opening', quantity: 5 },
        { storeId: store, variantId: apex20, movementType: 'sale', quantity: -4 },
      ]),
    ).rejects.toBeInstanceOf(InsufficientStockError);

    expect((await balance(store, apex20))?.onHand).toBe(3);
    expect(await balance(store, colorant)).toBeUndefined();
    const entries = await connection.db
      .select()
      .from(stockLedger)
      .where(eq(stockLedger.storeId, store));
    expect(entries).toHaveLength(1);
  });

  it('refuses stock going out of a store that never had any', async () => {
    const error = await post([
      { storeId: store, variantId: apex20, movementType: 'damage', quantity: -1 },
    ]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InsufficientStockError);
    expect(error).toMatchObject({
      storeId: store,
      variantId: apex20,
      name: 'InsufficientStockError',
    });
  });

  it('never oversells when many sales race for the last units', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 10 }]);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        post([{ storeId: store, variantId: apex20, movementType: 'sale', quantity: -1 }]),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect(
      results.filter((r) => r.status === 'rejected' && r.reason instanceof InsufficientStockError),
    ).toHaveLength(10);
    expect((await balance(store, apex20))?.onHand).toBe(0);
  });

  it('refuses to take stock that is reserved for orders', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 5 }]);
    await connection.db
      .update(stockBalances)
      .set({ reserved: 4 })
      .where(and(eq(stockBalances.storeId, store), eq(stockBalances.variantId, apex20)));

    await expect(
      post([{ storeId: store, variantId: apex20, movementType: 'sale', quantity: -2 }]),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    await post([{ storeId: store, variantId: apex20, movementType: 'sale', quantity: -1 }]);
    expect((await balance(store, apex20))?.onHand).toBe(4);
  });

  it('passes through a balance that would outgrow its column', async () => {
    await post([
      { storeId: store, variantId: apex20, movementType: 'opening', quantity: 99_999_999_999 },
    ]);

    const message = await failureMessage(
      post([{ storeId: store, variantId: apex20, movementType: 'adjustment', quantity: 1 }]),
    );

    expect(message).toMatch(/numeric field overflow/);
  });

  it('passes other database errors through', async () => {
    const message = await failureMessage(
      post([
        {
          storeId: store,
          variantId: apex20,
          movementType: 'opening',
          quantity: 1,
          unitCostPaise: -5,
        },
      ]),
    );

    expect(message).toMatch(/stock_ledger_unit_cost_not_negative/);
  });
});

describe('postStockMovementsInBulk', () => {
  const bulk = postWith(postStockMovementsInBulk);
  const balancesAt = (storeId: string) =>
    connection.db
      .select({
        variantId: stockBalances.variantId,
        onHand: stockBalances.onHand,
        avgCostPaise: stockBalances.avgCostPaise,
      })
      .from(stockBalances)
      .where(eq(stockBalances.storeId, storeId))
      .orderBy(stockBalances.variantId);

  it('ends with the same balances and costs as posting one movement at a time', async () => {
    const oneByOne = store;
    const together = id(
      await connection.db
        .insert(stores)
        .values({ organizationId: org, name: 'Bulk', code: `B${String(Date.now()).slice(-8)}` })
        .returning(),
    );
    // A deterministic mix of receipts at odd costs, sales and adjustments, never below zero.
    const movements: Omit<StockMovement, 'organizationId' | 'storeId'>[] = [];
    const onHand = new Map<string, number>();
    let seed = 7;
    const next = () => (seed = (seed * 48_271) % 2_147_483_647);
    for (let index = 0; index < 120; index++) {
      const variantId = index % 3 === 0 ? colorant : apex20;
      const held = onHand.get(variantId) ?? 0;
      const roll = next() % 10;
      if (roll < 4 || held < 2) {
        const quantity = (next() % 9) + 1 + (variantId === colorant ? 0.125 : 0);
        movements.push({
          variantId,
          movementType: held === 0 && index < 3 ? 'opening' : 'purchase_receipt',
          quantity,
          unitCostPaise: roll === 0 ? null : 9_000 + (next() % 3_001),
        });
        onHand.set(variantId, held + quantity);
      } else {
        const quantity = Math.min(held, (next() % 3) + 1);
        movements.push({
          variantId,
          movementType: roll < 8 ? 'sale' : 'damage',
          quantity: -quantity,
        });
        onHand.set(variantId, held - quantity);
      }
    }
    for (const movement of movements) await post([{ ...movement, storeId: oneByOne }]);
    await bulk(movements.map((movement) => ({ ...movement, storeId: together })));

    expect(await balancesAt(together)).toEqual(await balancesAt(oneByOne));
    expect(await findStockMismatches(connection.db)).toEqual([]);
  });

  it('adds to balances that already exist, in more rows than one statement takes', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 5 }]);
    const many = Array.from({ length: 4_001 }, () => ({
      storeId: store,
      variantId: apex20,
      movementType: 'adjustment' as const,
      quantity: 1,
    }));
    await bulk(many);

    expect(await balance(store, apex20)).toMatchObject({ onHand: 4_006 });
    const [entries] = await connection.db
      .select({ count: sql<number>`count(*)::int` })
      .from(stockLedger)
      .where(eq(stockLedger.storeId, store));
    expect(entries?.count).toBe(4_002);
  });

  it('back-dates entries given a time and does nothing for no movements', async () => {
    const createdAt = new Date('2026-01-15T05:30:00.000Z');
    await withTenant(connection.db, org, async (tx) => {
      await postStockMovementsInBulk(tx, []);
      await postStockMovementsInBulk(tx, [
        {
          organizationId: org,
          storeId: store,
          variantId: apex20,
          movementType: 'opening',
          quantity: 2,
          createdAt,
        },
      ]);
    });

    const entries = await connection.db
      .select({ createdAt: stockLedger.createdAt })
      .from(stockLedger)
      .where(eq(stockLedger.storeId, store));
    expect(entries).toEqual([{ createdAt }]);
  });
});

describe('stock ledger rules', () => {
  it.each([
    ['opening', -1],
    ['purchase_receipt', 0],
    ['damage', 1],
    ['sale', 2],
    ['transfer_out', 1],
    ['adjustment', 0],
  ] as const)('refuses a %s of %d', async (movementType, quantity) => {
    const message = await failureMessage(
      connection.db
        .insert(stockLedger)
        .values({ organizationId: org, storeId: store, variantId: apex20, movementType, quantity }),
    );

    expect(message).toMatch(/stock_ledger_quantity_sign/);
  });

  it('can never be edited, deleted or truncated, even by the database owner', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 5 }]);

    const update = await failureMessage(
      connection.db
        .update(stockLedger)
        .set({ quantity: 500 })
        .where(eq(stockLedger.storeId, store)),
    );
    const remove = await failureMessage(
      connection.db.delete(stockLedger).where(eq(stockLedger.storeId, store)),
    );
    const truncate = await failureMessage(connection.db.execute(sql`truncate stock_ledger`));

    for (const message of [update, remove, truncate]) {
      expect(message).toMatch(/append-only/);
    }
  });

  it('gives tenants no permission to edit or delete entries at all', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 5 }]);

    const message = await failureMessage(
      withTenant(connection.db, org, (tx) => tx.update(stockLedger).set({ note: 'edited' })),
    );

    expect(message).toMatch(/permission denied/);
  });

  it('keeps reserved stock between zero and what is on hand', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 5 }]);

    const message = await failureMessage(
      connection.db
        .update(stockBalances)
        .set({ reserved: 6 })
        .where(and(eq(stockBalances.storeId, store), eq(stockBalances.variantId, apex20))),
    );

    expect(message).toMatch(/stock_balances_reserved_within_on_hand/);
  });
});

describe('tenant isolation', () => {
  it('keeps ledgers and balances inside their business', async () => {
    await post([{ storeId: hyd, variantId: apex20, movementType: 'opening', quantity: 1 }]);

    const seenByOther = await withTenant(connection.db, otherOrg, async (tx) => ({
      ledger: (await tx.select().from(stockLedger)).length,
      balances: (await tx.select().from(stockBalances)).length,
    }));

    expect(seenByOther).toEqual({ ledger: 0, balances: 0 });
  });

  it("refuses movements against another business's store", async () => {
    const message = await failureMessage(
      post([{ storeId: otherStore, variantId: apex20, movementType: 'opening', quantity: 1 }]),
    );

    expect(message).toMatch(/stock_ledger_store_fk/);
  });
});

describe('findStockMismatches', () => {
  it('finds nothing when every balance matches its ledger', async () => {
    await post([
      { storeId: pune, variantId: apex20, movementType: 'opening', quantity: 7 },
      { storeId: pune, variantId: colorant, movementType: 'opening', quantity: 2.5 },
    ]);
    await post([{ storeId: pune, variantId: apex20, movementType: 'sale', quantity: -3 }]);

    const mismatches = await findStockMismatches(connection.db);

    expect(mismatches.filter((m) => m.storeId === pune)).toEqual([]);
  });

  it('flags a balance that was changed without a ledger entry', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 4 }]);
    await connection.db
      .update(stockBalances)
      .set({ onHand: 40 })
      .where(and(eq(stockBalances.storeId, store), eq(stockBalances.variantId, apex20)));

    const mismatches = await findStockMismatches(connection.db);

    expect(mismatches).toContainEqual({
      organizationId: org,
      storeId: store,
      variantId: apex20,
      onHand: 40,
      ledgerTotal: 4,
    });
  });

  it('flags ledger entries that never reached a balance', async () => {
    await connection.db.insert(stockLedger).values({
      organizationId: org,
      storeId: store,
      variantId: colorant,
      movementType: 'opening',
      quantity: 3,
    });

    const mismatches = await findStockMismatches(connection.db);

    expect(mismatches).toContainEqual({
      organizationId: org,
      storeId: store,
      variantId: colorant,
      onHand: 0,
      ledgerTotal: 3,
    });
  });

  it('checks only the current business inside tenant scope', async () => {
    await post([{ storeId: store, variantId: apex20, movementType: 'opening', quantity: 1 }]);
    await connection.db
      .update(stockBalances)
      .set({ onHand: 99 })
      .where(and(eq(stockBalances.storeId, store), eq(stockBalances.variantId, apex20)));

    const forOther = await withTenant(connection.db, otherOrg, (tx) => findStockMismatches(tx));

    expect(forOther).toEqual([]);
  });
});
