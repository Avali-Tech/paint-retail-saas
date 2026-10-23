import 'reflect-metadata';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { DEFAULT_LEAD_TIME_DAYS, canAccessStore, suggestReorderLevels } from '@paint/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import type {
  ListRulesQuery,
  LowStockQuery,
  ReorderSuggestionsQuery,
  SaveRulesInput,
  SlowMoversQuery,
} from './reorder.schemas.js';
import { costFor } from '../auth/costs.js';

const {
  brands,
  parties,
  productVariants,
  products,
  reorderRules,
  stockBalances,
  stockLedger,
  stores,
  supplierProducts,
  supplierProfiles,
} = schema;

export interface ItemRef {
  readonly store: { readonly id: string; readonly code: string };
  readonly variant: {
    readonly id: string;
    readonly sku: string;
    readonly packSize: number;
    readonly unit: string;
    readonly label: string | null;
  };
  readonly product: { readonly name: string };
  readonly brand: { readonly name: string };
}

export interface RuleView extends ItemRef {
  readonly minQuantity: number;
  readonly reorderLevel: number;
  readonly maxQuantity: number;
}

export type Severity = 'out_of_stock' | 'below_minimum' | 'reorder';

export interface LowStockItem extends RuleView {
  readonly onHand: number;
  readonly available: number;
  readonly severity: Severity;
  /** Enough to bring available stock back up to the maximum. */
  readonly suggestedQuantity: number;
}

export interface SlowMover extends ItemRef {
  readonly onHand: number;
  /** When it last sold or was sent to another store; null if never. */
  readonly lastDemandAt: string | null;
  readonly daysIdle: number;
  /** Money tied up: on hand × average cost, in paise; null without a cost. */
  readonly valuePaise: number | null;
  readonly productId: string;
  /**
   * The other open store that sold most of it over the same window (net of
   * returns), to move it to; null when none did.
   */
  readonly sellsAt: {
    readonly store: { readonly id: string; readonly code: string; readonly name: string };
    readonly soldQuantity: number;
  } | null;
}

/** Reorder levels worked out from a product's sales and its supplier's lead time. */
export interface ReorderSuggestion extends ItemRef {
  /** Net packs sold (sales less returns) over the window. */
  readonly soldQuantity: number;
  readonly dailyRate: number;
  readonly leadTimeDays: number;
  /** The supplier the lead time comes from; null when none is recorded (the default is used). */
  readonly supplierName: string | null;
  /** The store's rule today; null when it has none. */
  readonly current: {
    readonly minQuantity: number;
    readonly reorderLevel: number;
    readonly maxQuantity: number;
  } | null;
  readonly suggested: {
    readonly minQuantity: number;
    readonly reorderLevel: number;
    readonly maxQuantity: number;
  };
}

export interface Page<T> {
  readonly items: T[];
  readonly total: number;
}

const itemColumns = {
  storeId: stores.id,
  storeCode: stores.code,
  variantId: productVariants.id,
  sku: productVariants.sku,
  packSize: productVariants.packSize,
  unit: productVariants.unit,
  label: productVariants.label,
  productName: products.name,
  brandName: brands.name,
};

const itemRef = (row: {
  storeId: string;
  storeCode: string;
  variantId: string;
  sku: string;
  packSize: number;
  unit: string;
  label: string | null;
  productName: string;
  brandName: string;
}): ItemRef => ({
  store: { id: row.storeId, code: row.storeCode },
  variant: {
    id: row.variantId,
    sku: row.sku,
    packSize: row.packSize,
    unit: row.unit,
    label: row.label,
  },
  product: { name: row.productName },
  brand: { name: row.brandName },
});

const round3 = (value: number) => Math.round(value * 1000) / 1000;

@Injectable()
export class ReorderService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Creates or replaces reorder rules, several at once. */
  saveRules(auth: AuthContext, input: SaveRulesInput): Promise<{ saved: number }> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const storeIds = [...new Set(input.rules.map((rule) => rule.storeId))];
      const variantIds = [...new Set(input.rules.map((rule) => rule.variantId))];
      const found = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(inArray(stores.id, storeIds));
      if (found.length !== storeIds.length || !storeIds.every((id) => canAccessStore(auth, id))) {
        throw new NotFoundException('Store not found');
      }
      const variants = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(inArray(productVariants.id, variantIds));
      if (variants.length !== variantIds.length)
        throw new BadRequestException('Unknown product variant');

      for (const rule of input.rules) {
        const levels = {
          minQuantity: rule.minQuantity,
          reorderLevel: rule.reorderLevel,
          maxQuantity: rule.maxQuantity,
          updatedByMemberId: auth.memberId,
        };
        await tx
          .insert(reorderRules)
          .values({
            organizationId: auth.organization.id,
            storeId: rule.storeId,
            variantId: rule.variantId,
            ...levels,
          })
          .onConflictDoUpdate({
            target: [reorderRules.storeId, reorderRules.variantId],
            set: { ...levels, updatedAt: sql`now()` },
          });
      }
      return { saved: input.rules.length };
    });
  }

  removeRule(auth: AuthContext, storeId: string, variantId: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (!canAccessStore(auth, storeId)) throw new NotFoundException('Reorder rule not found');
      const removed = await tx
        .delete(reorderRules)
        .where(and(eq(reorderRules.storeId, storeId), eq(reorderRules.variantId, variantId)))
        .returning({ storeId: reorderRules.storeId });
      if (removed.length === 0) throw new NotFoundException('Reorder rule not found');
    });
  }

  listRules(auth: AuthContext, query: ListRulesQuery): Promise<Page<RuleView>> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      this.assertStoreFilter(auth, query.storeId);
      const where = and(
        this.storeScope(auth, reorderRules.storeId, query.storeId),
        query.q
          ? or(
              ilike(productVariants.sku, containsPattern(query.q)),
              ilike(products.name, containsPattern(query.q)),
              ilike(brands.name, containsPattern(query.q)),
              ilike(productVariants.label, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await this.ruleRows(tx)
        .where(where)
        .orderBy(asc(stores.code), asc(productVariants.sku))
        .limit(query.limit)
        .offset(query.offset);
      const total = await this.countRules(tx, where);
      return {
        items: rows.map((row) => ({
          ...itemRef(row),
          minQuantity: row.minQuantity,
          reorderLevel: row.reorderLevel,
          maxQuantity: row.maxQuantity,
        })),
        total,
      };
    });
  }

  /** Products at or below their reorder level, most urgent first. */
  lowStock(auth: AuthContext, query: LowStockQuery): Promise<Page<LowStockItem>> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      this.assertStoreFilter(auth, query.storeId);
      const available = sql`coalesce(${stockBalances.onHand}, 0) - coalesce(${stockBalances.reserved}, 0)`;
      const where = and(
        this.storeScope(auth, reorderRules.storeId, query.storeId),
        eq(productVariants.isActive, true),
        eq(products.isActive, true),
        sql`${available} <= ${reorderRules.reorderLevel}`,
      );
      const severityRank = sql`case
        when ${available} <= 0 then 0
        when ${available} < ${reorderRules.minQuantity} then 1
        else 2 end`;
      const rows = await this.ruleRows(tx)
        .where(where)
        .orderBy(
          severityRank,
          sql`${available} - ${reorderRules.reorderLevel}`,
          asc(stores.code),
          asc(productVariants.sku),
        )
        .limit(query.limit)
        .offset(query.offset);
      const total = await this.countRules(tx, where);
      return {
        items: rows.map((row) => {
          const availableNow = round3(row.onHand - row.reserved);
          const severity: Severity =
            availableNow <= 0
              ? 'out_of_stock'
              : availableNow < row.minQuantity
                ? 'below_minimum'
                : 'reorder';
          return {
            ...itemRef(row),
            minQuantity: row.minQuantity,
            reorderLevel: row.reorderLevel,
            maxQuantity: row.maxQuantity,
            onHand: row.onHand,
            available: availableNow,
            severity,
            suggestedQuantity: round3(row.maxQuantity - availableNow),
          };
        }),
        total,
      };
    });
  }

  /** In-stock products with no sale or transfer out for at least `days` days, biggest value first. */
  slowMovers(auth: AuthContext, query: SlowMoversQuery): Promise<Page<SlowMover>> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      this.assertStoreFilter(auth, query.storeId);
      // When each product last sold or left by transfer, and first arrived, at each store:
      // one pass over the ledger instead of two look-ups per balance (per row and count).
      const movement = tx
        .select({
          storeId: stockLedger.storeId,
          variantId: stockLedger.variantId,
          lastDemandAt:
            sql<Date | null>`max(${stockLedger.createdAt}) filter (where ${stockLedger.movementType} in ('sale', 'transfer_out'))`.as(
              'last_demand_at',
            ),
          firstInAt:
            sql<Date | null>`min(${stockLedger.createdAt}) filter (where ${stockLedger.quantity} > 0)`.as(
              'first_in_at',
            ),
        })
        .from(stockLedger)
        .where(this.storeScope(auth, stockLedger.storeId, query.storeId))
        .groupBy(stockLedger.storeId, stockLedger.variantId)
        .as('movement');
      const lastDemand = movement.lastDemandAt;
      const daysIdle = sql<number>`floor(extract(epoch from now() - coalesce(${movement.lastDemandAt}, ${movement.firstInAt})) / 86400)::int`;
      const onMovement = and(
        eq(movement.storeId, stockBalances.storeId),
        eq(movement.variantId, stockBalances.variantId),
      );
      const value = sql<
        string | null
      >`round(${stockBalances.onHand} * ${stockBalances.avgCostPaise})`;
      const where = and(
        this.storeScope(auth, stockBalances.storeId, query.storeId),
        gt(stockBalances.onHand, 0),
        sql`${daysIdle} >= ${query.days}`,
      );
      const base = () =>
        tx
          .select({
            ...itemColumns,
            onHand: stockBalances.onHand,
            lastDemandAt: lastDemand,
            daysIdle,
            valuePaise: value,
            productId: products.id,
          })
          .from(stockBalances)
          .innerJoin(stores, eq(stores.id, stockBalances.storeId))
          .innerJoin(productVariants, eq(productVariants.id, stockBalances.variantId))
          .innerJoin(products, eq(products.id, productVariants.productId))
          .innerJoin(brands, eq(brands.id, products.brandId))
          .leftJoin(movement, onMovement);
      const rows = await base()
        .where(where)
        .orderBy(sql`${value} desc nulls last`, desc(daysIdle), asc(productVariants.sku))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(stockBalances)
        .leftJoin(movement, onMovement)
        .where(where);
      // Where each of them sells: net sales per open store over the same window.
      const sold =
        rows.length === 0
          ? []
          : await tx
              .select({
                storeId: stockLedger.storeId,
                variantId: stockLedger.variantId,
                code: stores.code,
                name: stores.name,
                sold: sql<number>`(-sum(${stockLedger.quantity}))::float8`,
              })
              .from(stockLedger)
              .innerJoin(stores, eq(stores.id, stockLedger.storeId))
              .where(
                and(
                  eq(stores.isActive, true),
                  inArray(stockLedger.movementType, ['sale', 'sale_return']),
                  inArray(
                    stockLedger.variantId,
                    rows.map((row) => row.variantId),
                  ),
                  sql`${stockLedger.createdAt} >= now() - make_interval(days => ${query.days})`,
                ),
              )
              .groupBy(stockLedger.storeId, stockLedger.variantId, stores.code, stores.name)
              .having(sql`-sum(${stockLedger.quantity}) > 0`)
              .orderBy(sql`-sum(${stockLedger.quantity}) desc`, asc(stores.code));
      return {
        items: rows.map((row) => {
          const best = sold.find(
            (candidate) =>
              candidate.variantId === row.variantId && candidate.storeId !== row.storeId,
          );
          return {
            ...itemRef(row),
            onHand: row.onHand,
            lastDemandAt: row.lastDemandAt ? new Date(row.lastDemandAt).toISOString() : null,
            daysIdle: row.daysIdle,
            valuePaise: costFor(auth, row.valuePaise === null ? null : Number(row.valuePaise)),
            productId: row.productId,
            sellsAt: best
              ? {
                  store: { id: best.storeId, code: best.code, name: best.name },
                  soldQuantity: round3(best.sold),
                }
              : null,
          };
        }),
        total: Number(totals?.total),
      };
    });
  }

  /**
   * Reorder levels for what sold at a store over the last `days`, from each
   * product's daily rate and the lead time of the supplier it last came from.
   * Fastest sellers first. Saving them is the ordinary PUT /reorder-rules.
   */
  suggestions(auth: AuthContext, query: ReorderSuggestionsQuery): Promise<Page<ReorderSuggestion>> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      this.assertStoreFilter(auth, query.storeId);
      const sold = sql<number>`(-sum(${stockLedger.quantity}))::float8`;
      const demand = tx
        .select({ variantId: stockLedger.variantId, sold: sold.as('sold') })
        .from(stockLedger)
        .where(
          and(
            eq(stockLedger.storeId, query.storeId),
            inArray(stockLedger.movementType, ['sale', 'sale_return']),
            sql`${stockLedger.createdAt} >= now() - make_interval(days => ${query.days})`,
          ),
        )
        .groupBy(stockLedger.variantId)
        .having(sql`-sum(${stockLedger.quantity}) > 0`)
        .as('demand');
      const rows = await tx
        .select({
          ...itemColumns,
          sold: demand.sold,
          minQuantity: reorderRules.minQuantity,
          reorderLevel: reorderRules.reorderLevel,
          maxQuantity: reorderRules.maxQuantity,
        })
        .from(demand)
        .innerJoin(stores, eq(stores.id, query.storeId))
        .innerJoin(productVariants, eq(productVariants.id, demand.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .innerJoin(brands, eq(brands.id, products.brandId))
        .leftJoin(
          reorderRules,
          and(
            eq(reorderRules.storeId, query.storeId),
            eq(reorderRules.variantId, demand.variantId),
          ),
        )
        .orderBy(desc(demand.sold), asc(productVariants.sku))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx.select({ total: count() }).from(demand);
      // The supplier each product last came from, for its lead time.
      const suppliers =
        rows.length === 0
          ? []
          : await tx
              .select({
                variantId: supplierProducts.variantId,
                name: parties.displayName,
                leadTimeDays: supplierProfiles.leadTimeDays,
              })
              .from(supplierProducts)
              .innerJoin(parties, eq(parties.id, supplierProducts.supplierPartyId))
              .leftJoin(
                supplierProfiles,
                eq(supplierProfiles.partyId, supplierProducts.supplierPartyId),
              )
              .where(
                inArray(
                  supplierProducts.variantId,
                  rows.map((row) => row.variantId),
                ),
              )
              .orderBy(
                sql`${supplierProducts.lastReceivedAt} desc nulls last`,
                sql`${supplierProfiles.leadTimeDays} desc nulls last`,
              );
      return {
        items: rows.map((row) => {
          const supplier = suppliers.find(
            (candidate) => candidate.variantId === row.variantId && candidate.leadTimeDays !== null,
          );
          const leadTimeDays = supplier?.leadTimeDays ?? DEFAULT_LEAD_TIME_DAYS;
          const levels = suggestReorderLevels({
            soldQuantity: row.sold,
            days: query.days,
            leadTimeDays,
            safetyDays: query.safetyDays,
          });
          return {
            ...itemRef(row),
            soldQuantity: row.sold,
            dailyRate: levels.dailyRate,
            leadTimeDays,
            supplierName: supplier?.name ?? null,
            current:
              row.reorderLevel === null
                ? null
                : {
                    minQuantity: Number(row.minQuantity),
                    reorderLevel: row.reorderLevel,
                    maxQuantity: Number(row.maxQuantity),
                  },
            suggested: {
              minQuantity: levels.minQuantity,
              reorderLevel: levels.reorderLevel,
              maxQuantity: levels.maxQuantity,
            },
          };
        }),
        total: Number(totals?.total),
      };
    });
  }

  // Helpers -----------------------------------------------------------------

  private ruleRows(tx: Transaction) {
    return tx
      .select({
        ...itemColumns,
        minQuantity: reorderRules.minQuantity,
        reorderLevel: reorderRules.reorderLevel,
        maxQuantity: reorderRules.maxQuantity,
        onHand: sql<number>`coalesce(${stockBalances.onHand}, 0)::float8`,
        reserved: sql<number>`coalesce(${stockBalances.reserved}, 0)::float8`,
      })
      .from(reorderRules)
      .innerJoin(stores, eq(stores.id, reorderRules.storeId))
      .innerJoin(productVariants, eq(productVariants.id, reorderRules.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.storeId, reorderRules.storeId),
          eq(stockBalances.variantId, reorderRules.variantId),
        ),
      )
      .$dynamic();
  }

  private async countRules(tx: Transaction, where: SQL | undefined): Promise<number> {
    const [totals] = await tx
      .select({ total: count() })
      .from(reorderRules)
      .innerJoin(productVariants, eq(productVariants.id, reorderRules.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(
        stockBalances,
        and(
          eq(stockBalances.storeId, reorderRules.storeId),
          eq(stockBalances.variantId, reorderRules.variantId),
        ),
      )
      .where(where);
    return Number(totals?.total);
  }

  private assertStoreFilter(auth: AuthContext, storeId: string | undefined): void {
    if (storeId && !canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
  }

  private storeScope(
    auth: AuthContext,
    column: AnyColumn,
    storeId: string | undefined,
  ): SQL | undefined {
    if (storeId) return eq(column, storeId);
    return auth.allStores ? undefined : inArray(column, [...auth.storeIds]);
  }
}
