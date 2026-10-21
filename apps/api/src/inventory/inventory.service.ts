import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InsufficientStockError,
  postStockMovements,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { canAccessStore } from '@paint/shared';
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
import { variantOrder } from '../catalog/variant-order.js';
import { containsPattern } from '../parties/party-access.js';
import type { CreateMovementInput, LedgerQuery, ListStockQuery } from './inventory.schemas.js';
import { costFor } from '../auth/costs.js';

const {
  brands,
  organizationMembers,
  productVariants,
  products,
  stockBalances,
  stockLedger,
  stores,
  users,
} = schema;

export interface StockRow {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly variant: {
    readonly id: string;
    readonly sku: string;
    readonly packSize: number;
    readonly unit: string;
    readonly label: string | null;
  };
  readonly product: { readonly id: string; readonly name: string };
  readonly brand: { readonly id: string; readonly name: string };
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
  readonly avgCostPaise: number | null;
  /** on hand × average cost, rounded to the paisa; null without a cost. */
  readonly valuePaise: number | null;
}

export interface StockPage {
  readonly items: StockRow[];
  readonly total: number;
}

export interface Availability {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
}

/** A store's free quantity of one product, and nothing else about its stock. */
export interface FreeStock {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly available: number;
}

export interface LedgerEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly movementType: string;
  readonly quantity: number;
  readonly unitCostPaise: number | null;
  readonly note: string | null;
  readonly store: { readonly id: string; readonly code: string };
  readonly variant: { readonly id: string; readonly sku: string };
  readonly createdBy: string | null;
}

export interface LedgerPage {
  readonly items: LedgerEntry[];
  readonly total: number;
}

@Injectable()
export class InventoryService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Records opening stock, an adjustment or a write-off for several products, all or nothing. */
  recordMovements(auth: AuthContext, input: CreateMovementInput): Promise<LedgerPage> {
    const organizationId = auth.organization.id;
    return withTenant(this.connection.db, organizationId, async (tx) => {
      const store = await this.accessibleStore(tx, auth, input.storeId);
      const variantIds = input.lines.map((line) => line.variantId);
      const variants = await tx
        .select({ id: productVariants.id, sku: productVariants.sku })
        .from(productVariants)
        .where(inArray(productVariants.id, variantIds));
      if (variants.length !== variantIds.length) {
        throw new BadRequestException('Unknown product variant');
      }
      const skuOf = new Map(variants.map((variant) => [variant.id, variant.sku]));

      if (input.type === 'opening') {
        const history = await tx
          .selectDistinct({ variantId: stockLedger.variantId })
          .from(stockLedger)
          .where(
            and(eq(stockLedger.storeId, store.id), inArray(stockLedger.variantId, variantIds)),
          );
        if (history.length > 0) {
          const skus = history.map((row) => skuOf.get(row.variantId)).join(', ');
          throw new ConflictException(
            `Opening stock is already recorded at ${store.code} for ${skus}. Use an adjustment instead.`,
          );
        }
      }

      const batchId = crypto.randomUUID();
      try {
        await postStockMovements(
          tx,
          input.lines.map((line) => ({
            organizationId,
            storeId: store.id,
            variantId: line.variantId,
            movementType: input.type,
            quantity: input.type === 'damage' ? -line.quantity : line.quantity,
            unitCostPaise: line.unitCostPaise ?? null,
            referenceType: 'stock_movement',
            referenceId: batchId,
            note: input.note,
            createdByMemberId: auth.memberId,
          })),
        );
      } catch (error) {
        if (error instanceof InsufficientStockError) {
          throw new ConflictException(
            `Not enough stock of ${String(skuOf.get(error.variantId))} at ${store.code}`,
          );
        }
        throw error;
      }
      return this.ledgerPage(tx, auth, eq(stockLedger.referenceId, batchId), 200, 0);
    });
  }

  listStock(auth: AuthContext, query: ListStockQuery): Promise<StockPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (query.storeId) await this.accessibleStore(tx, auth, query.storeId);
      const where = and(
        this.storeScope(auth, stockBalances.storeId),
        query.storeId ? eq(stockBalances.storeId, query.storeId) : undefined,
        query.productId ? eq(products.id, query.productId) : undefined,
        query.inStockOnly ? gt(stockBalances.onHand, 0) : undefined,
        query.q
          ? or(
              ilike(products.name, containsPattern(query.q)),
              ilike(brands.name, containsPattern(query.q)),
              ilike(productVariants.sku, containsPattern(query.q)),
              ilike(productVariants.label, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await tx
        .select({
          storeId: stores.id,
          storeCode: stores.code,
          storeName: stores.name,
          variantId: productVariants.id,
          sku: productVariants.sku,
          packSize: productVariants.packSize,
          unit: productVariants.unit,
          label: productVariants.label,
          productId: products.id,
          productName: products.name,
          brandId: brands.id,
          brandName: brands.name,
          onHand: stockBalances.onHand,
          reserved: stockBalances.reserved,
          available: sql<string>`${stockBalances.onHand} - ${stockBalances.reserved}`,
          avgCostPaise: stockBalances.avgCostPaise,
          valuePaise: sql<
            string | null
          >`round(${stockBalances.onHand} * ${stockBalances.avgCostPaise})`,
        })
        .from(stockBalances)
        .innerJoin(stores, eq(stores.id, stockBalances.storeId))
        .innerJoin(productVariants, eq(productVariants.id, stockBalances.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .innerJoin(brands, eq(brands.id, products.brandId))
        .where(where)
        .orderBy(
          asc(stores.code),
          sql`lower(${brands.name})`,
          sql`lower(${products.name})`,
          ...variantOrder(),
        )
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(stockBalances)
        .innerJoin(productVariants, eq(productVariants.id, stockBalances.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .innerJoin(brands, eq(brands.id, products.brandId))
        .where(where);
      return {
        items: rows.map((row) => ({
          store: { id: row.storeId, code: row.storeCode, name: row.storeName },
          variant: {
            id: row.variantId,
            sku: row.sku,
            packSize: row.packSize,
            unit: row.unit,
            label: row.label,
          },
          product: { id: row.productId, name: row.productName },
          brand: { id: row.brandId, name: row.brandName },
          onHand: row.onHand,
          reserved: row.reserved,
          available: Number(row.available),
          avgCostPaise: costFor(auth, row.avgCostPaise),
          valuePaise: costFor(auth, row.valuePaise === null ? null : Number(row.valuePaise)),
        })),
        total: Number(totals?.total),
      };
    });
  }

  /** Stock of one variant in every store the member can access (roadmap §3.16). */
  availability(auth: AuthContext, variantId: string): Promise<Availability[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [variant] = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.id, variantId));
      if (!variant) throw new NotFoundException('Product variant not found');
      const rows = await tx
        .select({
          id: stores.id,
          code: stores.code,
          name: stores.name,
          onHand: sql<string>`coalesce(${stockBalances.onHand}, 0)`,
          reserved: sql<string>`coalesce(${stockBalances.reserved}, 0)`,
        })
        .from(stores)
        .leftJoin(
          stockBalances,
          and(eq(stockBalances.storeId, stores.id), eq(stockBalances.variantId, variantId)),
        )
        .where(and(eq(stores.isActive, true), this.storeScope(auth, stores.id)))
        .orderBy(stores.code);
      return rows.map((row) => ({
        store: { id: row.id, code: row.code, name: row.name },
        onHand: Number(row.onHand),
        reserved: Number(row.reserved),
        available: Number(row.onHand) - Number(row.reserved),
      }));
    });
  }

  /**
   * Where else one product is free to sell: every open store with some on hand
   * and not held for orders, most first. Answers only the free quantity, so a
   * counter at one store can point a customer to another (or ask for a transfer)
   * without seeing that store's stock, costs or value.
   */
  freeElsewhere(auth: AuthContext, variantId: string): Promise<FreeStock[]> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [variant] = await tx
        .select({ id: productVariants.id })
        .from(productVariants)
        .where(eq(productVariants.id, variantId));
      if (!variant) throw new NotFoundException('Product variant not found');
      const free = sql<string>`${stockBalances.onHand} - ${stockBalances.reserved}`;
      const rows = await tx
        .select({ id: stores.id, code: stores.code, name: stores.name, available: free })
        .from(stockBalances)
        .innerJoin(stores, eq(stores.id, stockBalances.storeId))
        .where(
          and(eq(stockBalances.variantId, variantId), eq(stores.isActive, true), sql`${free} > 0`),
        )
        .orderBy(sql`${free} desc`, stores.code);
      return rows.map((row) => ({
        store: { id: row.id, code: row.code, name: row.name },
        available: Number(row.available),
      }));
    });
  }

  /** Stock movements, newest first. */
  ledger(auth: AuthContext, query: LedgerQuery): Promise<LedgerPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      if (query.storeId) await this.accessibleStore(tx, auth, query.storeId);
      const where = and(
        this.storeScope(auth, stockLedger.storeId),
        query.storeId ? eq(stockLedger.storeId, query.storeId) : undefined,
        query.variantId ? eq(stockLedger.variantId, query.variantId) : undefined,
      );
      return this.ledgerPage(tx, auth, where, query.limit, query.offset);
    });
  }

  private async ledgerPage(
    tx: Transaction,
    auth: AuthContext,
    where: SQL | undefined,
    limit: number,
    offset: number,
  ): Promise<LedgerPage> {
    const scoped = and(this.storeScope(auth, stockLedger.storeId), where);
    const rows = await tx
      .select({
        id: stockLedger.id,
        createdAt: stockLedger.createdAt,
        movementType: stockLedger.movementType,
        quantity: stockLedger.quantity,
        unitCostPaise: stockLedger.unitCostPaise,
        note: stockLedger.note,
        storeId: stores.id,
        storeCode: stores.code,
        variantId: productVariants.id,
        sku: productVariants.sku,
        createdBy: users.fullName,
      })
      .from(stockLedger)
      .innerJoin(stores, eq(stores.id, stockLedger.storeId))
      .innerJoin(productVariants, eq(productVariants.id, stockLedger.variantId))
      .leftJoin(organizationMembers, eq(organizationMembers.id, stockLedger.createdByMemberId))
      .leftJoin(users, eq(users.id, organizationMembers.userId))
      .where(scoped)
      .orderBy(desc(stockLedger.createdAt), asc(productVariants.sku), asc(stockLedger.id))
      .limit(limit)
      .offset(offset);
    const [totals] = await tx.select({ total: count() }).from(stockLedger).where(scoped);
    return {
      items: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        movementType: row.movementType,
        quantity: row.quantity,
        unitCostPaise: costFor(auth, row.unitCostPaise),
        note: row.note,
        store: { id: row.storeId, code: row.storeCode },
        variant: { id: row.variantId, sku: row.sku },
        createdBy: row.createdBy,
      })),
      total: Number(totals?.total),
    };
  }

  /** Limits a query to the member's stores. */
  private storeScope(auth: AuthContext, column: AnyColumn) {
    return auth.allStores ? undefined : inArray(column, [...auth.storeIds]);
  }

  /** The store, if it exists and the member can access it; 404 otherwise. */
  private async accessibleStore(tx: Transaction, auth: AuthContext, storeId: string) {
    const [store] = await tx
      .select({ id: stores.id, code: stores.code })
      .from(stores)
      .where(eq(stores.id, storeId));
    if (!store || !canAccessStore(auth, storeId)) throw new NotFoundException('Store not found');
    return store;
  }
}
