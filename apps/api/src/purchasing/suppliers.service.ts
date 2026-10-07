import 'reflect-metadata';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { and, asc, count, eq, ilike, or, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { containsPattern } from '../parties/party-access.js';
import { requireSupplier, requireVariants } from './purchasing-lookups.js';
import type {
  ListSuppliersQuery,
  SupplierProductsInput,
  SupplierProfileInput,
} from './purchasing.schemas.js';

const {
  brands,
  parties,
  partyRoles,
  productVariants,
  products,
  supplierProducts,
  supplierProfiles,
} = schema;

export interface SupplierSummary {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly gstin: string | null;
  /** Days of credit; 0 = cash. */
  readonly paymentTermsDays: number;
  readonly leadTimeDays: number | null;
  readonly productCount: number;
}

export interface SupplierProductView {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly packSize: number;
  readonly unit: string;
  readonly label: string | null;
  readonly supplierSku: string | null;
  readonly lastCostPaise: number | null;
  readonly lastReceivedAt: string | null;
}

export interface SupplierView extends SupplierSummary {
  readonly products: SupplierProductView[];
}

export interface SupplierPage {
  readonly items: SupplierSummary[];
  readonly total: number;
}

@Injectable()
export class SuppliersService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  list(auth: AuthContext, query: ListSuppliersQuery): Promise<SupplierPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const where = and(
        eq(parties.isActive, true),
        query.q
          ? or(
              ilike(parties.displayName, containsPattern(query.q)),
              ilike(parties.gstin, containsPattern(query.q)),
            )
          : undefined,
      );
      const rows = await this.summaries(tx)
        .where(where)
        .orderBy(asc(parties.displayName), asc(parties.id))
        .limit(query.limit)
        .offset(query.offset);
      const [totals] = await tx
        .select({ total: count() })
        .from(parties)
        .innerJoin(
          partyRoles,
          and(eq(partyRoles.partyId, parties.id), eq(partyRoles.role, 'supplier')),
        )
        .where(where);
      return { items: rows.map((row) => this.summary(row)), total: Number(totals?.total) };
    });
  }

  get(auth: AuthContext, supplierId: string): Promise<SupplierView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) => this.view(tx, supplierId));
  }

  saveProfile(
    auth: AuthContext,
    supplierId: string,
    input: SupplierProfileInput,
  ): Promise<SupplierView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireSupplier(tx, supplierId);
      await tx
        .insert(supplierProfiles)
        .values({ organizationId: auth.organization.id, partyId: supplierId, ...input })
        .onConflictDoUpdate({
          target: supplierProfiles.partyId,
          set: { ...input, updatedAt: sql`now()` },
        });
      return this.view(tx, supplierId);
    });
  }

  saveProducts(
    auth: AuthContext,
    supplierId: string,
    input: SupplierProductsInput,
  ): Promise<SupplierView> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireSupplier(tx, supplierId);
      await requireVariants(
        tx,
        input.products.map((product) => product.variantId),
      );
      await tx
        .insert(supplierProducts)
        .values(
          input.products.map((product) => ({
            organizationId: auth.organization.id,
            supplierPartyId: supplierId,
            variantId: product.variantId,
            supplierSku: product.supplierSku,
          })),
        )
        .onConflictDoUpdate({
          target: [supplierProducts.supplierPartyId, supplierProducts.variantId],
          set: { supplierSku: sql`excluded.supplier_sku` },
        });
      return this.view(tx, supplierId);
    });
  }

  removeProduct(auth: AuthContext, supplierId: string, variantId: string): Promise<void> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      await requireSupplier(tx, supplierId);
      const removed = await tx
        .delete(supplierProducts)
        .where(
          and(
            eq(supplierProducts.supplierPartyId, supplierId),
            eq(supplierProducts.variantId, variantId),
          ),
        )
        .returning({ variantId: supplierProducts.variantId });
      if (removed.length === 0)
        throw new NotFoundException('This supplier does not list that product');
    });
  }

  // Helpers -----------------------------------------------------------------

  private summaries(tx: Transaction) {
    return tx
      .select({
        id: parties.id,
        name: parties.displayName,
        phone: parties.phone,
        gstin: parties.gstin,
        paymentTermsDays: supplierProfiles.paymentTermsDays,
        leadTimeDays: supplierProfiles.leadTimeDays,
        productCount: sql<number>`(select count(*)::int from ${supplierProducts} where ${supplierProducts.supplierPartyId} = ${parties.id})`,
      })
      .from(parties)
      .innerJoin(
        partyRoles,
        and(eq(partyRoles.partyId, parties.id), eq(partyRoles.role, 'supplier')),
      )
      .leftJoin(supplierProfiles, eq(supplierProfiles.partyId, parties.id))
      .$dynamic();
  }

  private summary(row: {
    id: string;
    name: string;
    phone: string | null;
    gstin: string | null;
    paymentTermsDays: number | null;
    leadTimeDays: number | null;
    productCount: number;
  }): SupplierSummary {
    return { ...row, paymentTermsDays: Number(row.paymentTermsDays) };
  }

  private async view(tx: Transaction, supplierId: string): Promise<SupplierView> {
    const [row] = await this.summaries(tx).where(
      and(eq(parties.id, supplierId), eq(parties.isActive, true)),
    );
    if (!row) throw new NotFoundException('Supplier not found');
    const rows = await tx
      .select({
        link: supplierProducts,
        sku: productVariants.sku,
        productName: products.name,
        brandName: brands.name,
        packSize: productVariants.packSize,
        unit: productVariants.unit,
        label: productVariants.label,
      })
      .from(supplierProducts)
      .innerJoin(productVariants, eq(productVariants.id, supplierProducts.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(eq(supplierProducts.supplierPartyId, supplierId))
      .orderBy(asc(productVariants.sku));
    return {
      ...this.summary(row),
      products: rows.map(({ link, ...product }) => ({
        variantId: link.variantId,
        sku: product.sku,
        productName: product.productName,
        brandName: product.brandName,
        packSize: product.packSize,
        unit: product.unit,
        label: product.label,
        supplierSku: link.supplierSku,
        lastCostPaise: link.lastCostPaise,
        lastReceivedAt: link.lastReceivedAt ? link.lastReceivedAt.toISOString() : null,
      })),
    };
  }
}
