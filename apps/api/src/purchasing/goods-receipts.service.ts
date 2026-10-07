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
  postStockMovements,
  schema,
  withTenant,
  type DatabaseConnection,
  type StockMovement,
  type Transaction,
} from '@paint/db';
import { canAccessStore, formatDocumentNumber } from '@paint/shared';
import { and, asc, count, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { requireStore, requireSupplier, type PartySummary } from './purchasing-lookups.js';
import {
  lineValue,
  round3,
  storeScope,
  storeSummary,
  totalValue,
  type StoreSummary,
} from './purchasing-views.js';
import type { CreateGoodsReceiptInput, ListGoodsReceiptsQuery } from './purchasing.schemas.js';

const {
  brands,
  goodsReceiptLines,
  goodsReceipts,
  parties,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  stores,
  supplierProducts,
} = schema;

export interface GoodsReceiptLineView {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly packSize: number;
  readonly unit: string;
  readonly label: string | null;
  readonly quantity: number;
  readonly freeQuantity: number;
  readonly unitCostPaise: number | null;
  /** Paid units × cost; free units carry no value. */
  readonly valuePaise: number | null;
}

export interface GoodsReceiptView {
  readonly id: string;
  readonly number: string;
  readonly store: StoreSummary;
  readonly supplier: PartySummary;
  readonly purchaseOrder: { readonly id: string; readonly number: string } | null;
  readonly supplierInvoiceNumber: string | null;
  readonly supplierInvoiceDate: string | null;
  readonly note: string | null;
  readonly receivedAt: string;
  readonly lines: GoodsReceiptLineView[];
  readonly totalValuePaise: number;
}

export interface GoodsReceiptSummary {
  readonly id: string;
  readonly number: string;
  readonly store: StoreSummary;
  readonly supplier: { readonly id: string; readonly name: string };
  readonly purchaseOrderNumber: string | null;
  readonly supplierInvoiceNumber: string | null;
  readonly receivedAt: string;
  readonly totalValuePaise: number;
}

export interface GoodsReceiptPage {
  readonly items: GoodsReceiptSummary[];
  readonly total: number;
}

/** What the receipt is against: the order's lines, or none for a direct receipt. */
interface Source {
  readonly storeId: string;
  readonly supplierId: string;
  readonly order: { readonly id: string; readonly number: string } | null;
  readonly orderLines: Map<string, { pending: number; unitCostPaise: number | null }>;
}

const receiptTotal = sql<string>`(
  select coalesce(sum(round(${goodsReceiptLines.quantity} * ${goodsReceiptLines.unitCostPaise})), 0)
  from ${goodsReceiptLines} where ${goodsReceiptLines.goodsReceiptId} = ${goodsReceipts.id}
)`;

@Injectable()
export class GoodsReceiptsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /**
   * Brings goods into a store: posts paid and free units to stock, advances the
   * purchase order, and remembers each product's cost from this supplier.
   */
  create(auth: AuthContext, input: CreateGoodsReceiptInput): Promise<GoodsReceiptView> {
    const organizationId = auth.organization.id;
    return withTenant(this.connection.db, organizationId, async (tx) => {
      const source = input.purchaseOrderId
        ? await this.fromOrder(tx, auth, input.purchaseOrderId)
        : await this.direct(tx, auth, input);
      const variantIds = input.lines.map((line) => line.variantId);
      const skus = new Map(
        (
          await tx
            .select({ id: productVariants.id, sku: productVariants.sku })
            .from(productVariants)
            .where(inArray(productVariants.id, variantIds))
        ).map((row) => [row.id, row.sku]),
      );
      const lastCosts = new Map(
        (
          await tx
            .select({ variantId: supplierProducts.variantId, cost: supplierProducts.lastCostPaise })
            .from(supplierProducts)
            .where(
              and(
                eq(supplierProducts.supplierPartyId, source.supplierId),
                inArray(supplierProducts.variantId, variantIds),
              ),
            )
        ).map((row) => [row.variantId, row.cost]),
      );
      const lines = input.lines.map((line) => {
        const sku = skus.get(line.variantId);
        if (!sku) throw new BadRequestException('Unknown product variant');
        const ordered = source.orderLines.get(line.variantId);
        if (source.order) {
          if (!ordered) throw new BadRequestException(`${sku} is not on ${source.order.number}`);
          if (line.quantity > ordered.pending) {
            throw new BadRequestException(
              `More ${sku} than is still due on ${source.order.number} (${String(ordered.pending)})`,
            );
          }
        }
        return {
          ...line,
          sku,
          unitCostPaise:
            line.unitCostPaise ?? ordered?.unitCostPaise ?? lastCosts.get(line.variantId) ?? null,
        };
      });

      const id = crypto.randomUUID();
      const number = formatDocumentNumber(
        'GRN',
        await nextDocumentNumber(tx, organizationId, 'goods_receipt'),
      );
      const inserted = await tx
        .insert(goodsReceipts)
        .values({
          id,
          organizationId,
          number,
          storeId: source.storeId,
          supplierPartyId: source.supplierId,
          purchaseOrderId: source.order?.id,
          supplierInvoiceNumber: input.supplierInvoiceNumber,
          supplierInvoiceDate: input.supplierInvoiceDate,
          note: input.note,
          receivedByMemberId: auth.memberId,
        })
        // The only possible conflict is the supplier's invoice number.
        .onConflictDoNothing()
        .returning({ id: goodsReceipts.id });
      if (inserted.length === 0) {
        throw new ConflictException(
          `Invoice ${String(input.supplierInvoiceNumber)} from this supplier is already entered`,
        );
      }
      await tx.insert(goodsReceiptLines).values(
        lines.map((line) => ({
          organizationId,
          goodsReceiptId: id,
          variantId: line.variantId,
          quantity: line.quantity,
          freeQuantity: line.freeQuantity,
          unitCostPaise: line.unitCostPaise,
        })),
      );

      if (source.order) await this.advanceOrder(tx, source.order.id, lines);

      const movements: StockMovement[] = [];
      for (const line of lines) {
        const base = {
          organizationId,
          storeId: source.storeId,
          variantId: line.variantId,
          movementType: 'purchase_receipt' as const,
          referenceType: 'goods_receipt',
          referenceId: id,
          createdByMemberId: auth.memberId,
        };
        if (line.quantity > 0) {
          movements.push({
            ...base,
            quantity: line.quantity,
            unitCostPaise: line.unitCostPaise,
            note: number,
          });
        }
        if (line.freeQuantity > 0) {
          movements.push({
            ...base,
            quantity: line.freeQuantity,
            unitCostPaise: 0,
            note: `${number} free (scheme)`,
          });
        }
      }
      await postStockMovements(tx, movements);

      // Remember what this supplier charged, for the next order.
      await tx
        .insert(supplierProducts)
        .values(
          lines.map((line) => ({
            organizationId,
            supplierPartyId: source.supplierId,
            variantId: line.variantId,
            lastCostPaise: line.quantity > 0 ? line.unitCostPaise : null,
            lastReceivedAt: sql`now()`,
          })),
        )
        .onConflictDoUpdate({
          target: [supplierProducts.supplierPartyId, supplierProducts.variantId],
          set: {
            lastCostPaise: sql`coalesce(excluded.last_cost_paise, ${supplierProducts.lastCostPaise})`,
            lastReceivedAt: sql`now()`,
          },
        });
      return this.view(tx, auth, id);
    });
  }

  list(auth: AuthContext, query: ListGoodsReceiptsQuery): Promise<GoodsReceiptPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        storeScope(auth, goodsReceipts.storeId, query.storeId),
        query.supplierId ? eq(goodsReceipts.supplierPartyId, query.supplierId) : undefined,
        query.purchaseOrderId
          ? eq(goodsReceipts.purchaseOrderId, query.purchaseOrderId)
          : undefined,
      );
      const rows = await tx
        .select({
          receipt: goodsReceipts,
          store: stores,
          supplierName: parties.displayName,
          orderNumber: purchaseOrders.number,
          total: receiptTotal,
        })
        .from(goodsReceipts)
        .innerJoin(stores, eq(stores.id, goodsReceipts.storeId))
        .innerJoin(parties, eq(parties.id, goodsReceipts.supplierPartyId))
        .leftJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
        .where(where)
        .orderBy(desc(goodsReceipts.receivedAt), desc(goodsReceipts.number))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx.select({ total: count() }).from(goodsReceipts).where(where);
      return {
        items: rows.map(({ receipt, store, supplierName, orderNumber, total }) => ({
          id: receipt.id,
          number: receipt.number,
          store: storeSummary(store),
          supplier: { id: receipt.supplierPartyId, name: supplierName },
          purchaseOrderNumber: orderNumber,
          supplierInvoiceNumber: receipt.supplierInvoiceNumber,
          receivedAt: receipt.receivedAt.toISOString(),
          totalValuePaise: Number(total),
        })),
        total: Number(totals?.total),
      };
    });
  }

  get(auth: AuthContext, receiptId: string): Promise<GoodsReceiptView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      this.view(tx, auth, receiptId),
    );
  }

  // Helpers -----------------------------------------------------------------

  /** Locks the order, so two receipts against it are applied one at a time. */
  private async fromOrder(tx: Transaction, auth: AuthContext, orderId: string): Promise<Source> {
    const [order] = await tx
      .select()
      .from(purchaseOrders)
      .where(eq(purchaseOrders.id, orderId))
      .for('update');
    if (!order || !canAccessStore(auth, order.storeId)) {
      throw new NotFoundException('Purchase order not found');
    }
    if (order.status !== 'open' && order.status !== 'partially_received') {
      throw new ConflictException(`${order.number} is ${order.status}`);
    }
    const lines = await tx
      .select()
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, orderId));
    return {
      storeId: order.storeId,
      supplierId: order.supplierPartyId,
      order: { id: order.id, number: order.number },
      orderLines: new Map(
        lines.map((line) => [
          line.variantId,
          {
            pending: round3(line.orderedQuantity - line.receivedQuantity),
            unitCostPaise: line.unitCostPaise,
          },
        ]),
      ),
    };
  }

  private async direct(
    tx: Transaction,
    auth: AuthContext,
    input: CreateGoodsReceiptInput,
  ): Promise<Source> {
    // The schema requires both when there is no purchase order.
    const storeId = String(input.storeId);
    const supplierId = String(input.supplierId);
    await requireStore(tx, auth, storeId);
    await requireSupplier(tx, supplierId);
    return { storeId, supplierId, order: null, orderLines: new Map() };
  }

  /** Adds the paid units to the order, then marks it received once nothing is due. */
  private async advanceOrder(
    tx: Transaction,
    orderId: string,
    lines: { variantId: string; quantity: number }[],
  ): Promise<void> {
    for (const line of lines) {
      await tx
        .update(purchaseOrderLines)
        .set({ receivedQuantity: sql`${purchaseOrderLines.receivedQuantity} + ${line.quantity}` })
        .where(
          and(
            eq(purchaseOrderLines.purchaseOrderId, orderId),
            eq(purchaseOrderLines.variantId, line.variantId),
          ),
        );
    }
    const [due] = await tx
      .select({ lines: count() })
      .from(purchaseOrderLines)
      .where(
        and(
          eq(purchaseOrderLines.purchaseOrderId, orderId),
          lt(purchaseOrderLines.receivedQuantity, purchaseOrderLines.orderedQuantity),
        ),
      );
    await tx
      .update(purchaseOrders)
      .set({
        status: Number(due?.lines) === 0 ? 'received' : 'partially_received',
        updatedAt: sql`now()`,
      })
      .where(eq(purchaseOrders.id, orderId));
  }

  private async view(
    tx: Transaction,
    auth: AuthContext,
    receiptId: string,
  ): Promise<GoodsReceiptView> {
    const [row] = await tx
      .select({
        receipt: goodsReceipts,
        store: stores,
        supplier: { id: parties.id, name: parties.displayName, gstin: parties.gstin },
        purchaseOrder: { id: purchaseOrders.id, number: purchaseOrders.number },
      })
      .from(goodsReceipts)
      .innerJoin(stores, eq(stores.id, goodsReceipts.storeId))
      .innerJoin(parties, eq(parties.id, goodsReceipts.supplierPartyId))
      .leftJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
      .where(eq(goodsReceipts.id, receiptId));
    if (!row || !canAccessStore(auth, row.receipt.storeId)) {
      throw new NotFoundException('Goods receipt not found');
    }
    const { receipt, store, supplier, purchaseOrder } = row;
    const lineRows = await tx
      .select({
        line: goodsReceiptLines,
        sku: productVariants.sku,
        productName: products.name,
        brandName: brands.name,
        packSize: productVariants.packSize,
        unit: productVariants.unit,
        label: productVariants.label,
      })
      .from(goodsReceiptLines)
      .innerJoin(productVariants, eq(productVariants.id, goodsReceiptLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(eq(goodsReceiptLines.goodsReceiptId, receiptId))
      .orderBy(asc(productVariants.sku));
    const lines = lineRows.map(({ line, ...product }) => ({
      variantId: line.variantId,
      ...product,
      quantity: line.quantity,
      freeQuantity: line.freeQuantity,
      unitCostPaise: line.unitCostPaise,
      valuePaise: lineValue(line.quantity, line.unitCostPaise),
    }));
    return {
      id: receipt.id,
      number: receipt.number,
      store: storeSummary(store),
      supplier,
      purchaseOrder,
      supplierInvoiceNumber: receipt.supplierInvoiceNumber,
      supplierInvoiceDate: receipt.supplierInvoiceDate,
      note: receipt.note,
      receivedAt: receipt.receivedAt.toISOString(),
      lines,
      totalValuePaise: totalValue(lines.map((line) => line.valuePaise)),
    };
  }
}
