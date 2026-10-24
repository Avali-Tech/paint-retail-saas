import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { canAccessStore, mistintLoss, type MistintPage, type MistintView } from '@paint/shared';
import { and, count, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { costFor } from '../auth/costs.js';
import { DATABASE } from '../database/database.module.js';
import type {
  ListMistintsQuery,
  RecordMistintInput,
  WriteOffMistintInput,
} from './mistints.schemas.js';

const {
  brands,
  mistintedCans,
  organizationMembers,
  productVariants,
  products,
  stockBalances,
  stores,
  taxDocumentLines,
  taxDocuments,
  users,
} = schema;

/**
 * Mistinted cans: recorded by the store that made them (they leave sellable
 * stock at once), seen by every branch so any can sell them, written off by
 * the store's stock staff. Sold through a counter bill (billing).
 */
@Injectable()
export class MistintsService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** Takes a mistinted can out of sellable stock and lists it for every branch. */
  record(auth: AuthContext, input: RecordMistintInput): Promise<MistintView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [store] = await tx
        .select({ id: stores.id, code: stores.code })
        .from(stores)
        .where(eq(stores.id, input.storeId));
      if (!store || !canAccessStore(auth, store.id)) throw new NotFoundException('Store not found');
      // Whoever tints at the counter, or the store's stock staff.
      if (!auth.permissions.has('billing:issue') && !auth.permissions.has('inventory:manage')) {
        throw new ForbiddenException('You cannot record mistinted cans');
      }
      const [variant] = await tx
        .select({ sku: productVariants.sku, avgCostPaise: stockBalances.avgCostPaise })
        .from(productVariants)
        .leftJoin(
          stockBalances,
          and(eq(stockBalances.variantId, productVariants.id), eq(stockBalances.storeId, store.id)),
        )
        .where(eq(productVariants.id, input.variantId));
      if (!variant) throw new BadRequestException('Unknown product variant');
      const id = crypto.randomUUID();
      try {
        await postStockMovements(tx, [
          {
            organizationId: auth.organization.id,
            storeId: store.id,
            variantId: input.variantId,
            movementType: 'mistint',
            quantity: -input.quantity,
            referenceType: 'mistinted_can',
            referenceId: id,
            note: `Mistinted ${input.shadeCode}: ${input.reason}`,
            createdByMemberId: auth.memberId,
          },
        ]);
      } catch (error) {
        if (error instanceof InsufficientStockError) {
          throw new ConflictException(`Not enough stock of ${variant.sku} at ${store.code}`);
        }
        throw error;
      }
      await tx.insert(mistintedCans).values({
        id,
        organizationId: auth.organization.id,
        storeId: store.id,
        variantId: input.variantId,
        quantity: input.quantity,
        shadeCode: input.shadeCode,
        shadeName: input.shadeName ?? null,
        intendedShade: input.intendedShade ?? null,
        reason: input.reason,
        costPaise:
          variant.avgCostPaise === null ? null : Math.round(variant.avgCostPaise * input.quantity),
        createdByMemberId: auth.memberId,
      });
      return this.view(tx, auth, id);
    });
  }

  /** Every branch's mistinted cans, newest first; the ones waiting to be sold by default. */
  list(auth: AuthContext, query: ListMistintsQuery): Promise<MistintPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        eq(mistintedCans.status, query.status ?? 'available'),
        query.storeId ? eq(mistintedCans.storeId, query.storeId) : undefined,
      );
      const rows = await this.rows(tx, where, query.limit, query.offset);
      const [totals] = await tx.select({ total: count() }).from(mistintedCans).where(where);
      return { items: rows.map((row) => toView(auth, row)), total: Number(totals?.total) };
    });
  }

  get(auth: AuthContext, id: string): Promise<MistintView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.view(tx, auth, id));
  }

  /** Writes off a can no one will buy: all its cost is the loss. Stock staff at its store. */
  writeOff(auth: AuthContext, id: string, input: WriteOffMistintInput): Promise<MistintView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const [can] = await tx
        .select({ storeId: mistintedCans.storeId, status: mistintedCans.status })
        .from(mistintedCans)
        .where(eq(mistintedCans.id, id))
        .for('update');
      if (!can) throw new NotFoundException('Mistinted can not found');
      if (!canAccessStore(auth, can.storeId) || !auth.permissions.has('inventory:manage')) {
        throw new ForbiddenException('Only stock staff at its store can write it off');
      }
      if (can.status !== 'available') {
        throw new ConflictException('This can is already sold or written off');
      }
      await tx
        .update(mistintedCans)
        .set({
          status: 'written_off',
          note: input.note,
          resolvedAt: sql`now()`,
          resolvedByMemberId: auth.memberId,
          updatedAt: sql`now()`,
        })
        .where(eq(mistintedCans.id, id));
      return this.view(tx, auth, id);
    });
  }

  private async view(tx: Transaction, auth: AuthContext, id: string): Promise<MistintView> {
    const [row] = await this.rows(tx, eq(mistintedCans.id, id), 1, 0);
    if (!row) throw new NotFoundException('Mistinted can not found');
    return toView(auth, row);
  }

  private rows(tx: Transaction, where: SQL | undefined, limit: number, offset: number) {
    // The issued bill that sold it, if any.
    const soldOn = tx
      .select({
        canId: taxDocumentLines.mistintCanId,
        documentId: taxDocuments.id,
        number: taxDocuments.number,
      })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, eq(taxDocuments.id, taxDocumentLines.documentId))
      .where(
        sql`${taxDocuments.status} = 'issued' and ${taxDocumentLines.mistintCanId} is not null`,
      )
      .as('sold_on');
    return tx
      .select({
        can: mistintedCans,
        storeCode: stores.code,
        storeName: stores.name,
        sku: productVariants.sku,
        packSize: productVariants.packSize,
        unit: sql<string>`${productVariants.unit}::text`,
        label: productVariants.label,
        productId: products.id,
        productName: products.name,
        brandName: brands.name,
        createdBy: users.fullName,
        documentId: soldOn.documentId,
        number: soldOn.number,
      })
      .from(mistintedCans)
      .innerJoin(stores, eq(stores.id, mistintedCans.storeId))
      .innerJoin(productVariants, eq(productVariants.id, mistintedCans.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .innerJoin(organizationMembers, eq(organizationMembers.id, mistintedCans.createdByMemberId))
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(soldOn, eq(soldOn.canId, mistintedCans.id))
      .where(where)
      .orderBy(desc(mistintedCans.createdAt), desc(mistintedCans.id))
      .limit(limit)
      .offset(offset);
  }
}

type Row = Awaited<ReturnType<MistintsService['rows']>>[number];

function toView(auth: AuthContext, row: Row): MistintView {
  const { can } = row;
  const costPaise = costFor(auth, can.costPaise);
  return {
    id: can.id,
    status: can.status,
    store: { id: can.storeId, code: row.storeCode, name: row.storeName },
    variant: {
      id: can.variantId,
      sku: row.sku,
      packSize: row.packSize,
      unit: row.unit,
      label: row.label,
    },
    product: { id: row.productId, name: row.productName },
    brand: { name: row.brandName },
    quantity: can.quantity,
    shadeCode: can.shadeCode,
    shadeName: can.shadeName,
    intendedShade: can.intendedShade,
    reason: can.reason,
    costPaise,
    soldTaxablePaise: can.soldTaxablePaise,
    lossPaise: mistintLoss(can.status, costPaise, can.soldTaxablePaise),
    invoice: row.documentId === null ? null : { id: row.documentId, number: String(row.number) },
    note: can.note,
    createdAt: can.createdAt.toISOString(),
    createdBy: row.createdBy,
    resolvedAt: can.resolvedAt?.toISOString() ?? null,
  };
}
