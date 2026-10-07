import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  nextDocumentNumber,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import { canAccessStore, formatDocumentNumber } from '@paint/shared';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import {
  requireStore,
  requireSupplier,
  requireVariants,
  type PartySummary,
} from './purchasing-lookups.js';
import {
  lineValue,
  round3,
  storeScope,
  storeSummary,
  totalValue,
  type StoreSummary,
} from './purchasing-views.js';
import type {
  CreatePurchaseOrderInput,
  FromLowStockInput,
  ListPurchaseOrdersQuery,
  PURCHASE_ORDER_STATUSES,
} from './purchasing.schemas.js';

const {
  brands,
  goodsReceipts,
  parties,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  reorderRules,
  stockBalances,
  stores,
  supplierProducts,
} = schema;

type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export interface PurchaseOrderLineView {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly packSize: number;
  readonly unit: string;
  readonly label: string | null;
  readonly orderedQuantity: number;
  readonly receivedQuantity: number;
  /** Still to arrive. */
  readonly pendingQuantity: number;
  readonly unitCostPaise: number | null;
  readonly valuePaise: number | null;
}

export interface PurchaseOrderView {
  readonly id: string;
  readonly number: string;
  readonly status: PurchaseOrderStatus;
  readonly supplier: PartySummary;
  readonly store: StoreSummary;
  readonly expectedDate: string | null;
  readonly note: string | null;
  readonly closingReason: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly lines: PurchaseOrderLineView[];
  /** Ordered value of the lines with a known cost. */
  readonly totalValuePaise: number;
  readonly receipts: {
    readonly id: string;
    readonly number: string;
    readonly supplierInvoiceNumber: string | null;
    readonly receivedAt: string;
  }[];
}

export interface PurchaseOrderSummary {
  readonly id: string;
  readonly number: string;
  readonly status: PurchaseOrderStatus;
  readonly supplier: { readonly id: string; readonly name: string };
  readonly store: StoreSummary;
  readonly expectedDate: string | null;
  readonly createdAt: string;
  readonly lineCount: number;
  readonly totalValuePaise: number;
}

export interface PurchaseOrderPage {
  readonly items: PurchaseOrderSummary[];
  readonly total: number;
}

interface NewOrder {
  readonly supplierId: string;
  readonly storeId: string;
  readonly expectedDate?: string;
  readonly note?: string;
  readonly lines: { variantId: string; quantity: number; unitCostPaise: number | null }[];
}

const orderTotal = sql<string>`(
  select coalesce(sum(round(${purchaseOrderLines.orderedQuantity} * ${purchaseOrderLines.unitCostPaise})), 0)
  from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id}
)`;

@Injectable()
export class PurchaseOrdersService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  create(auth: AuthContext, input: CreatePurchaseOrderInput): Promise<PurchaseOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireSupplier(tx, input.supplierId);
      await requireStore(tx, auth, input.storeId);
      const variantIds = input.lines.map((line) => line.variantId);
      await requireVariants(tx, variantIds);
      const lastCosts = new Map(
        (
          await tx
            .select({ variantId: supplierProducts.variantId, cost: supplierProducts.lastCostPaise })
            .from(supplierProducts)
            .where(
              and(
                eq(supplierProducts.supplierPartyId, input.supplierId),
                inArray(supplierProducts.variantId, variantIds),
              ),
            )
        ).map((row) => [row.variantId, row.cost]),
      );
      return this.insert(tx, auth, {
        ...input,
        lines: input.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          unitCostPaise: line.unitCostPaise ?? lastCosts.get(line.variantId) ?? null,
        })),
      });
    });
  }

  /**
   * The quick reorder: every product low at the store (at or below its reorder
   * level) that the supplier provides, or the chosen ones, ordered up to the
   * maximum. Cost: the supplier's last cost, else the store's average cost.
   */
  fromLowStock(auth: AuthContext, input: FromLowStockInput): Promise<PurchaseOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireSupplier(tx, input.supplierId);
      await requireStore(tx, auth, input.storeId);
      const available = sql`coalesce(${stockBalances.onHand}, 0) - coalesce(${stockBalances.reserved}, 0)`;
      const rows = await tx
        .select({
          variantId: reorderRules.variantId,
          quantity: sql<string>`${reorderRules.maxQuantity} - (${available})`,
          unitCostPaise: sql<
            string | null
          >`coalesce(${supplierProducts.lastCostPaise}, ${stockBalances.avgCostPaise})`,
        })
        .from(reorderRules)
        .innerJoin(productVariants, eq(productVariants.id, reorderRules.variantId))
        .innerJoin(products, eq(products.id, productVariants.productId))
        .leftJoin(
          stockBalances,
          and(
            eq(stockBalances.storeId, reorderRules.storeId),
            eq(stockBalances.variantId, reorderRules.variantId),
          ),
        )
        .leftJoin(
          supplierProducts,
          and(
            eq(supplierProducts.supplierPartyId, input.supplierId),
            eq(supplierProducts.variantId, reorderRules.variantId),
          ),
        )
        .where(
          and(
            eq(reorderRules.storeId, input.storeId),
            eq(productVariants.isActive, true),
            eq(products.isActive, true),
            sql`${available} <= ${reorderRules.reorderLevel}`,
            sql`${reorderRules.maxQuantity} > ${available}`,
            input.variantIds
              ? inArray(reorderRules.variantId, input.variantIds)
              : sql`${supplierProducts.variantId} is not null`,
          ),
        )
        .orderBy(asc(productVariants.sku));
      if (rows.length === 0) {
        throw new BadRequestException('Nothing at this store needs reordering from this supplier');
      }
      return this.insert(tx, auth, {
        ...input,
        lines: rows.map((row) => ({
          variantId: row.variantId,
          quantity: round3(Number(row.quantity)),
          unitCostPaise: row.unitCostPaise === null ? null : Number(row.unitCostPaise),
        })),
      });
    });
  }

  list(auth: AuthContext, query: ListPurchaseOrdersQuery): Promise<PurchaseOrderPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        storeScope(auth, purchaseOrders.storeId, query.storeId),
        query.status ? eq(purchaseOrders.status, query.status) : undefined,
        query.supplierId ? eq(purchaseOrders.supplierPartyId, query.supplierId) : undefined,
      );
      const rows = await tx
        .select({
          order: purchaseOrders,
          store: stores,
          supplierName: parties.displayName,
          lineCount: sql<number>`(select count(*)::int from ${purchaseOrderLines} where ${purchaseOrderLines.purchaseOrderId} = ${purchaseOrders.id})`,
          total: orderTotal,
        })
        .from(purchaseOrders)
        .innerJoin(stores, eq(stores.id, purchaseOrders.storeId))
        .innerJoin(parties, eq(parties.id, purchaseOrders.supplierPartyId))
        .where(where)
        .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.number))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx.select({ total: count() }).from(purchaseOrders).where(where);
      return {
        items: rows.map(({ order, store, supplierName, lineCount, total }) => ({
          id: order.id,
          number: order.number,
          status: order.status,
          supplier: { id: order.supplierPartyId, name: supplierName },
          store: storeSummary(store),
          expectedDate: order.expectedDate,
          createdAt: order.createdAt.toISOString(),
          lineCount,
          totalValuePaise: Number(total),
        })),
        total: Number(totals?.total),
      };
    });
  }

  get(auth: AuthContext, orderId: string): Promise<PurchaseOrderView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, orderId),
    );
  }

  /** Withdraws an order before anything has arrived. */
  cancel(auth: AuthContext, orderId: string, reason: string): Promise<PurchaseOrderView> {
    return this.act(auth, orderId, 'open', 'cancelled', reason);
  }

  /** Short-closes a partly received order: the rest will not come. */
  close(auth: AuthContext, orderId: string, reason: string): Promise<PurchaseOrderView> {
    return this.act(auth, orderId, 'partially_received', 'closed', reason);
  }

  // Helpers -----------------------------------------------------------------

  private async insert(
    tx: Transaction,
    auth: AuthContext,
    order: NewOrder,
  ): Promise<PurchaseOrderView> {
    const organizationId = auth.organization.id;
    const id = crypto.randomUUID();
    const number = formatDocumentNumber(
      'PO',
      await nextDocumentNumber(tx, organizationId, 'purchase_order'),
    );
    await tx.insert(purchaseOrders).values({
      id,
      organizationId,
      number,
      supplierPartyId: order.supplierId,
      storeId: order.storeId,
      expectedDate: order.expectedDate,
      note: order.note,
      createdByMemberId: auth.memberId,
    });
    await tx.insert(purchaseOrderLines).values(
      order.lines.map((line) => ({
        organizationId,
        purchaseOrderId: id,
        variantId: line.variantId,
        orderedQuantity: line.quantity,
        unitCostPaise: line.unitCostPaise,
      })),
    );
    return this.view(tx, auth, id);
  }

  /** Moves the status only from the expected one, so a double click or a race cannot apply it twice. */
  private act(
    auth: AuthContext,
    orderId: string,
    from: PurchaseOrderStatus,
    to: PurchaseOrderStatus,
    reason: string,
  ): Promise<PurchaseOrderView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const { order } = await this.load(tx, auth, orderId);
      if (order.status !== from) {
        throw new ConflictException(
          from === 'open' && order.status === 'partially_received'
            ? 'Goods have already arrived against this order; close it instead'
            : `This purchase order is ${order.status.replace('_', ' ')}`,
        );
      }
      const moved = await tx
        .update(purchaseOrders)
        .set({
          status: to,
          closingReason: reason,
          closedByMemberId: auth.memberId,
          closedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(purchaseOrders.id, orderId), eq(purchaseOrders.status, from)))
        .returning({ id: purchaseOrders.id });
      if (moved.length === 0) {
        throw new ConflictException('Someone else just changed this purchase order; reload it');
      }
      return this.view(tx, auth, orderId);
    });
  }

  /** The order with its store and supplier; 404 unless the member works at the store. */
  private async load(tx: Transaction, auth: AuthContext, orderId: string) {
    const [row] = await tx
      .select({
        order: purchaseOrders,
        store: stores,
        supplier: { id: parties.id, name: parties.displayName, gstin: parties.gstin },
      })
      .from(purchaseOrders)
      .innerJoin(stores, eq(stores.id, purchaseOrders.storeId))
      .innerJoin(parties, eq(parties.id, purchaseOrders.supplierPartyId))
      .where(eq(purchaseOrders.id, orderId));
    if (!row || !canAccessStore(auth, row.order.storeId)) {
      throw new NotFoundException('Purchase order not found');
    }
    return row;
  }

  private async view(
    tx: Transaction,
    auth: AuthContext,
    orderId: string,
  ): Promise<PurchaseOrderView> {
    const { order, store, supplier } = await this.load(tx, auth, orderId);
    const lineRows = await tx
      .select({
        line: purchaseOrderLines,
        sku: productVariants.sku,
        packSize: productVariants.packSize,
        unit: productVariants.unit,
        label: productVariants.label,
        productName: products.name,
        brandName: brands.name,
      })
      .from(purchaseOrderLines)
      .innerJoin(productVariants, eq(productVariants.id, purchaseOrderLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(eq(purchaseOrderLines.purchaseOrderId, orderId))
      .orderBy(asc(productVariants.sku));
    const receipts = await tx
      .select({
        id: goodsReceipts.id,
        number: goodsReceipts.number,
        supplierInvoiceNumber: goodsReceipts.supplierInvoiceNumber,
        receivedAt: goodsReceipts.receivedAt,
      })
      .from(goodsReceipts)
      .where(eq(goodsReceipts.purchaseOrderId, orderId))
      .orderBy(asc(goodsReceipts.number));
    const lines = lineRows.map(({ line, ...product }) => ({
      variantId: line.variantId,
      ...product,
      orderedQuantity: line.orderedQuantity,
      receivedQuantity: line.receivedQuantity,
      pendingQuantity: round3(line.orderedQuantity - line.receivedQuantity),
      unitCostPaise: line.unitCostPaise,
      valuePaise: lineValue(line.orderedQuantity, line.unitCostPaise),
    }));
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      supplier,
      store: storeSummary(store),
      expectedDate: order.expectedDate,
      note: order.note,
      closingReason: order.closingReason,
      createdAt: order.createdAt.toISOString(),
      closedAt: order.closedAt ? order.closedAt.toISOString() : null,
      lines,
      totalValuePaise: totalValue(lines.map((line) => line.valuePaise)),
      receipts: receipts.map((receipt) => ({
        ...receipt,
        receivedAt: receipt.receivedAt.toISOString(),
      })),
    };
  }
}
