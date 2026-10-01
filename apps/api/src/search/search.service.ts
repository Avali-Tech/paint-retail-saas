import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import { quickActions, type QuickAction } from '@paint/shared';
import {
  and,
  asc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { storeScope } from '../leads/crm-lookups.js';
import { containsPattern, phoneSearchDigits } from '../parties/party-access.js';
import type { SearchQuery } from './search.schemas.js';

const {
  brands,
  goodsReceipts,
  leads,
  opportunities,
  parties,
  productBarcodes,
  productVariants,
  products,
  projects,
  purchaseOrders,
  stockCounts,
  stores,
  transfers,
} = schema;

const fromStores = alias(stores, 'from_store');
const toStores = alias(stores, 'to_store');

export interface SearchHit {
  readonly id: string;
  /** Main line, e.g. a name or "Asian Paints Apex Ultima 20 l". */
  readonly title: string;
  /** Second line, e.g. a mobile number, SKU or stage. */
  readonly subtitle: string | null;
  /** Where the web app opens it. */
  readonly path: string;
}

export interface SearchResults {
  readonly query: string;
  readonly actions: QuickAction[];
  /** Each group is null when the member cannot see that kind of record. */
  readonly parties: SearchHit[] | null;
  readonly products: SearchHit[] | null;
  readonly leads: SearchHit[] | null;
  readonly opportunities: SearchHit[] | null;
  readonly projects: SearchHit[] | null;
  /** Transfers, purchase orders, goods receipts and stock counts found by number. */
  readonly documents: SearchHit[];
}

/** Every word must appear in at least one of the columns. */
const allWords = (words: string[], columns: AnyColumn[]): SQL | undefined =>
  and(...words.map((word) => or(...columns.map((column) => ilike(column, containsPattern(word))))));

/** A LIKE pattern for text at the start, with LIKE's special characters escaped. */
const prefixPattern = (text: string) => `${containsPattern(text).slice(1, -1)}%`;

/** 0 for an exact match, 1 when it starts with the search, 2 otherwise. */
const rank = (column: AnyColumn, term: string) =>
  sql`case when lower(${column}) = lower(${term}) then 0 when ${column} ilike ${prefixPattern(term)} then 1 else 2 end`;

/** One search box for everything (roadmap P1-M21), within what the member may see. */
@Injectable()
export class SearchService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  search(auth: AuthContext, query: SearchQuery): Promise<SearchResults> {
    const term = query.q;
    const words = term.split(/\s+/);
    const can = (permission: Parameters<typeof auth.permissions.has>[0]) =>
      auth.permissions.has(permission);
    return withTenant(this.connection.db, auth.organization.id, async (tx) => ({
      query: term,
      actions: quickActions(auth, term),
      parties: can('parties:read') ? await this.parties(tx, auth, term, words, query.limit) : null,
      products: can('catalog:read') ? await this.products(tx, term, words, query.limit) : null,
      leads: can('leads:read') ? await this.leads(tx, auth, term, words, query.limit) : null,
      opportunities: can('leads:read')
        ? await this.opportunities(tx, auth, term, words, query.limit)
        : null,
      projects: can('projects:read')
        ? await this.projects(tx, auth, term, words, query.limit)
        : null,
      documents: /\d/.test(term) ? await this.documents(tx, auth, term, query.limit) : [],
    }));
  }

  /** Customers, contractors, suppliers… by name, mobile number or GSTIN. */
  private async parties(
    tx: Transaction,
    auth: AuthContext,
    term: string,
    words: string[],
    limit: number,
  ): Promise<SearchHit[]> {
    const digits = phoneSearchDigits(term);
    const rows = await tx
      .select({
        id: parties.id,
        name: parties.displayName,
        phone: parties.phone,
        roles: sql<
          string[]
        >`array(select role::text from party_roles where party_id = ${parties.id} order by role)`,
      })
      .from(parties)
      .where(
        and(
          eq(parties.isActive, true),
          auth.allStores
            ? undefined
            : or(isNull(parties.homeStoreId), inArray(parties.homeStoreId, [...auth.storeIds])),
          or(
            allWords(words, [parties.displayName, parties.legalName]),
            ilike(parties.gstin, prefixPattern(term)),
            digits
              ? or(
                  ilike(parties.phone, containsPattern(digits)),
                  ilike(parties.alternatePhone, containsPattern(digits)),
                )
              : undefined,
          ),
        ),
      )
      .orderBy(rank(parties.displayName, term), asc(parties.displayName))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      title: row.name,
      subtitle: [row.phone, row.roles.join(', ')].filter(Boolean).join(' · '),
      path: `/parties/${row.id}`,
    }));
  }

  /** Products by name, brand, SKU, or exactly by barcode. */
  private async products(
    tx: Transaction,
    term: string,
    words: string[],
    limit: number,
  ): Promise<SearchHit[]> {
    const barcode = exists(
      tx
        .select({ one: sql`1` })
        .from(productBarcodes)
        .where(
          and(eq(productBarcodes.variantId, productVariants.id), eq(productBarcodes.barcode, term)),
        ),
    );
    const rows = await tx
      .select({
        variantId: productVariants.id,
        productId: products.id,
        sku: productVariants.sku,
        packSize: productVariants.packSize,
        unit: productVariants.unit,
        productName: products.name,
        brandName: brands.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(
        and(
          eq(productVariants.isActive, true),
          eq(products.isActive, true),
          or(allWords(words, [productVariants.sku, products.name, brands.name]), barcode),
        ),
      )
      .orderBy(
        sql`case when ${barcode} then 0 else 1 end`,
        rank(productVariants.sku, term),
        rank(products.name, term),
        asc(productVariants.sku),
      )
      .limit(limit);
    return rows.map((row) => ({
      id: row.variantId,
      title: `${row.brandName} ${row.productName} ${String(row.packSize)} ${row.unit}`,
      subtitle: row.sku,
      path: `/products/${row.productId}`,
    }));
  }

  private async leads(
    tx: Transaction,
    auth: AuthContext,
    term: string,
    words: string[],
    limit: number,
  ): Promise<SearchHit[]> {
    const rows = await tx
      .select({
        id: leads.id,
        number: leads.number,
        title: leads.title,
        stage: leads.stage,
        party: parties.displayName,
      })
      .from(leads)
      .innerJoin(parties, eq(parties.id, leads.partyId))
      .where(
        and(
          storeScope(auth, leads.storeId),
          allWords(words, [leads.number, leads.title, parties.displayName]),
        ),
      )
      .orderBy(rank(leads.number, term), rank(leads.title, term), asc(leads.number))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      title: `${row.number} · ${row.title}`,
      subtitle: `${row.party} · ${row.stage}`,
      path: `/leads/${row.id}`,
    }));
  }

  private async opportunities(
    tx: Transaction,
    auth: AuthContext,
    term: string,
    words: string[],
    limit: number,
  ): Promise<SearchHit[]> {
    const rows = await tx
      .select({
        id: opportunities.id,
        number: opportunities.number,
        title: opportunities.title,
        stage: opportunities.stage,
        party: parties.displayName,
      })
      .from(opportunities)
      .innerJoin(parties, eq(parties.id, opportunities.partyId))
      .where(
        and(
          storeScope(auth, opportunities.storeId),
          allWords(words, [opportunities.number, opportunities.title, parties.displayName]),
        ),
      )
      .orderBy(
        rank(opportunities.number, term),
        rank(opportunities.title, term),
        asc(opportunities.number),
      )
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      title: `${row.number} · ${row.title}`,
      subtitle: `${row.party} · ${row.stage}`,
      path: `/opportunities/${row.id}`,
    }));
  }

  private async projects(
    tx: Transaction,
    auth: AuthContext,
    term: string,
    words: string[],
    limit: number,
  ): Promise<SearchHit[]> {
    const rows = await tx
      .select({
        id: projects.id,
        number: projects.number,
        name: projects.name,
        city: projects.city,
        stage: projects.stage,
        customer: parties.displayName,
      })
      .from(projects)
      .innerJoin(parties, eq(parties.id, projects.customerPartyId))
      .where(
        and(
          storeScope(auth, projects.storeId),
          allWords(words, [projects.number, projects.name, projects.city, parties.displayName]),
        ),
      )
      .orderBy(rank(projects.number, term), rank(projects.name, term), asc(projects.number))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      title: `${row.number} · ${row.name}`,
      subtitle: [row.customer, row.city, row.stage].filter(Boolean).join(' · '),
      path: `/projects/${row.id}`,
    }));
  }

  /** Stock and purchasing documents by number, e.g. "TR-000012" or just "12". */
  private async documents(
    tx: Transaction,
    auth: AuthContext,
    term: string,
    limit: number,
  ): Promise<SearchHit[]> {
    const pattern = containsPattern(term);
    const hits: SearchHit[] = [];
    if (auth.permissions.has('inventory:read')) {
      const transferRows = await tx
        .select({
          id: transfers.id,
          number: transfers.number,
          status: transfers.status,
          from: fromStores.code,
          to: toStores.code,
        })
        .from(transfers)
        .innerJoin(fromStores, eq(fromStores.id, transfers.fromStoreId))
        .innerJoin(toStores, eq(toStores.id, transfers.toStoreId))
        .where(
          and(
            ilike(transfers.number, pattern),
            or(storeScope(auth, transfers.fromStoreId), storeScope(auth, transfers.toStoreId)),
          ),
        )
        .orderBy(asc(transfers.number))
        .limit(limit);
      hits.push(
        ...transferRows.map((row) => ({
          id: row.id,
          title: row.number,
          subtitle: `Transfer ${row.from} → ${row.to} · ${row.status}`,
          path: `/transfers/${row.id}`,
        })),
      );
      const countRows = await tx
        .select({
          id: stockCounts.id,
          number: stockCounts.number,
          status: stockCounts.status,
          store: stores.code,
        })
        .from(stockCounts)
        .innerJoin(stores, eq(stores.id, stockCounts.storeId))
        .where(and(ilike(stockCounts.number, pattern), storeScope(auth, stockCounts.storeId)))
        .orderBy(asc(stockCounts.number))
        .limit(limit);
      hits.push(
        ...countRows.map((row) => ({
          id: row.id,
          title: row.number,
          subtitle: `Stock count ${row.store} · ${row.status}`,
          path: `/stock-counts/${row.id}`,
        })),
      );
    }
    if (auth.permissions.has('purchasing:read')) {
      const orderRows = await tx
        .select({
          id: purchaseOrders.id,
          number: purchaseOrders.number,
          status: purchaseOrders.status,
          supplier: parties.displayName,
        })
        .from(purchaseOrders)
        .innerJoin(parties, eq(parties.id, purchaseOrders.supplierPartyId))
        .where(and(ilike(purchaseOrders.number, pattern), storeScope(auth, purchaseOrders.storeId)))
        .orderBy(asc(purchaseOrders.number))
        .limit(limit);
      hits.push(
        ...orderRows.map((row) => ({
          id: row.id,
          title: row.number,
          subtitle: `Purchase order · ${row.supplier} · ${row.status}`,
          path: `/purchase-orders/${row.id}`,
        })),
      );
      const receiptRows = await tx
        .select({
          id: goodsReceipts.id,
          number: goodsReceipts.number,
          supplier: parties.displayName,
          invoice: goodsReceipts.supplierInvoiceNumber,
        })
        .from(goodsReceipts)
        .innerJoin(parties, eq(parties.id, goodsReceipts.supplierPartyId))
        .where(
          and(
            or(
              ilike(goodsReceipts.number, pattern),
              ilike(goodsReceipts.supplierInvoiceNumber, pattern),
            ),
            storeScope(auth, goodsReceipts.storeId),
          ),
        )
        .orderBy(asc(goodsReceipts.number))
        .limit(limit);
      hits.push(
        ...receiptRows.map((row) => ({
          id: row.id,
          title: row.number,
          subtitle: ['Goods receipt', row.supplier, row.invoice].filter(Boolean).join(' · '),
          path: `/goods-receipts/${row.id}`,
        })),
      );
    }
    return hits.slice(0, limit);
  }
}
