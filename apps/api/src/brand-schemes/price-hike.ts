import { NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import {
  addDays,
  canAccessStore,
  planStockUp,
  productTitle,
  type PriceHikePlanView,
  type StockUpSku,
} from '@paint/shared';
import { and, asc, eq, inArray, or, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { indiaToday } from '../billing/invoice-view.js';
import { only } from '../common/only.js';
import { withinIndiaDays } from '../common/india-days.js';
import type { PriceHikeBody } from './brand-schemes.schemas.js';

const { brands, productVariants, products, stockBalances, stockLedger, supplierProducts } = schema;

/**
 * The price-hike planner (P2-M33, research; spec §6.3): for each active pack of the
 * brand (or of the products and categories named), today's stock, the units sold over
 * the sales window and today's cost feed the engine's `planStockUp`.
 *
 * - Stock: on hand now, at the store named, else at every store the member works at.
 * - Sold: units out on sales less units back on sales returns over the window ending
 *   today (stock ledger), never below 0; whole units (rounded down).
 * - Cost: the last price paid any supplier for the pack (the latest GRN's), else its
 *   weighted average cost in stock. A pack with neither is left out and counted.
 */
export async function planPriceHike(
  tx: Transaction,
  auth: AuthContext,
  body: PriceHikeBody,
): Promise<PriceHikePlanView> {
  const brand = only(
    await tx
      .select({ id: brands.id, name: brands.name })
      .from(brands)
      .where(eq(brands.id, body.brandId)),
    'Brand',
  );
  if (body.storeId !== null && !canAccessStore(auth, body.storeId)) {
    throw new NotFoundException('Store not found');
  }
  const asOf = await indiaToday(tx);
  const storeScope = (column: AnyColumn): SQL | undefined =>
    body.storeId !== null
      ? eq(column, body.storeId)
      : auth.allStores
        ? undefined
        : inArray(column, [...auth.storeIds, '00000000-0000-0000-0000-000000000000']);

  const variants = await tx
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      productName: products.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(products.brandId, body.brandId),
        eq(productVariants.isActive, true),
        body.productIds.length + body.categoryIds.length === 0
          ? undefined
          : or(
              body.productIds.length > 0 ? inArray(products.id, body.productIds) : undefined,
              body.categoryIds.length > 0
                ? inArray(products.categoryId, body.categoryIds)
                : undefined,
            ),
      ),
    )
    .orderBy(asc(products.name), asc(productVariants.sku));
  const ids = variants.map((variant) => variant.variantId);

  const stock = await tx
    .select({
      variantId: stockBalances.variantId,
      onHand: sql<string>`sum(${stockBalances.onHand})`,
      averageCost: sql<
        string | null
      >`round(sum(${stockBalances.onHand} * ${stockBalances.avgCostPaise}) filter (where ${stockBalances.avgCostPaise} is not null)
        / nullif(sum(${stockBalances.onHand}) filter (where ${stockBalances.avgCostPaise} is not null), 0))`,
    })
    .from(stockBalances)
    .where(and(inArray(stockBalances.variantId, ids), storeScope(stockBalances.storeId)))
    .groupBy(stockBalances.variantId);
  const sold = await tx
    .select({
      variantId: stockLedger.variantId,
      units: sql<string>`-sum(${stockLedger.quantity})`,
    })
    .from(stockLedger)
    .where(
      and(
        inArray(stockLedger.variantId, ids),
        inArray(stockLedger.movementType, ['sale', 'sale_return']),
        storeScope(stockLedger.storeId),
        withinIndiaDays(stockLedger.createdAt, addDays(asOf, 1 - body.salesWindowDays), asOf),
      ),
    )
    .groupBy(stockLedger.variantId);
  const lastCosts = await tx
    .selectDistinctOn([supplierProducts.variantId], {
      variantId: supplierProducts.variantId,
      cost: supplierProducts.lastCostPaise,
    })
    .from(supplierProducts)
    .where(
      and(
        inArray(supplierProducts.variantId, ids),
        sql`${supplierProducts.lastCostPaise} is not null`,
      ),
    )
    .orderBy(supplierProducts.variantId, sql`${supplierProducts.lastReceivedAt} desc nulls last`);

  const stockOf = new Map(stock.map((row) => [row.variantId, row]));
  const soldOf = new Map(sold.map((row) => [row.variantId, Number(row.units)]));
  const costOf = new Map(lastCosts.map((row) => [row.variantId, row.cost]));
  const skus: (StockUpSku & { sku: string; productName: string })[] = [];
  let withoutCost = 0;
  for (const variant of variants) {
    const held = stockOf.get(variant.variantId);
    const cost = costOf.get(variant.variantId) ?? held?.averageCost ?? null;
    if (cost === null) {
      withoutCost += 1;
      continue;
    }
    skus.push({
      variantId: variant.variantId,
      sku: variant.sku,
      productName: productTitle(brand.name, variant.productName),
      unitCostPaise: Number(cost),
      stockUnits: Math.floor(Number(held?.onHand ?? 0)),
      soldUnits: Math.max(Math.floor(soldOf.get(variant.variantId) ?? 0), 0),
      salesWindowDays: body.salesWindowDays,
      deadStockRiskBps: null,
    });
  }
  return {
    asOf,
    brand,
    plan: planStockUp(
      { hikeBasisPoints: body.hikeBasisPoints, effectiveOn: body.effectiveOn },
      skus,
      asOf,
      rates(body),
    ),
    skus: skus.map((sku) => ({
      variantId: sku.variantId,
      sku: sku.sku,
      productName: sku.productName,
      unitCostPaise: sku.unitCostPaise,
      stockUnits: sku.stockUnits,
      soldUnits: sku.soldUnits,
    })),
    withoutCost,
  };
}

const rates = (body: PriceHikeBody) => ({
  holdingCostBps: body.holdingCostBps,
  costOfMoneyBps: body.costOfMoneyBps,
  deadStockRiskBps: body.deadStockRiskBps,
  maxCoverDays: body.maxCoverDays,
});
