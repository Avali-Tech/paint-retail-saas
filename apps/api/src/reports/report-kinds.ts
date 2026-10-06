import { schema, type Transaction } from '@paint/db';
import { paiseToRupees, type Permission } from '@paint/shared';
import { and, asc, desc, eq, or, sql, type AnyColumn } from 'drizzle-orm';
import { alias, type PgSelect } from 'drizzle-orm/pg-core';
import type { z } from 'zod';
import type { AuthContext } from '../auth/auth-context.js';
import { withinIndiaDays } from '../common/india-days.js';
import { storeScope } from '../leads/crm-lookups.js';
import {
  booleanFilter,
  dateFilter,
  enumFilter,
  reportFilters,
  storeFilter,
  supplierFilter,
  type ReportFilter,
} from './report-filters.js';

const {
  brands,
  goodsReceiptLines,
  goodsReceipts,
  leads,
  organizationMembers,
  parties,
  productVariants,
  products,
  projects,
  purchaseOrders,
  stockBalances,
  stockLedger,
  stores,
  transferLines,
  transfers,
  users,
} = schema;

export type ReportValue = string | number | null;
export type ReportRow = Record<string, ReportValue>;

export interface ReportColumn {
  readonly key: string;
  readonly header: string;
}

export interface ReportKind<F> {
  readonly kind: string;
  readonly title: string;
  readonly permission: Permission;
  readonly columns: readonly ReportColumn[];
  /** The filters this report understands, besides format and paging. */
  readonly filters: z.ZodType<F, Record<string, unknown>>;
  /** The same filters described for the web app (GET /reports). */
  readonly filterInfo: readonly ReportFilter[];
  /** The rows, newest or most relevant first; `select` turns a query into rows. */
  query(tx: Transaction, auth: AuthContext, filters: F): PgSelect;
  toRow(record: Record<string, unknown>): ReportRow;
}

const store = { storeId: storeFilter };
const dateRange = { from: dateFilter, to: dateFilter };

/** A moment as people in India read it, e.g. "2026-10-01 18:05". */
const ist = (column: AnyColumn) =>
  sql<string | null>`to_char(${column} at time zone 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI')`;
const rupees = (paise: unknown) =>
  paise === null ? null : paiseToRupees(Math.round(Number(paise)));
const quantity = (value: unknown) =>
  value === null ? null : Math.round(Number(value) * 1000) / 1000;
const text = (value: unknown) => value as string | null;

const fromStores = alias(stores, 'from_store');
const toStores = alias(stores, 'to_store');
const assignees = alias(organizationMembers, 'assignee');
const assigneeUsers = alias(users, 'assignee_user');
const creators = alias(organizationMembers, 'creator');
const creatorUsers = alias(users, 'creator_user');

const stockByLocation: ReportKind<{ storeId?: string; inStockOnly: boolean }> = {
  kind: 'stock-by-location',
  title: 'Stock by location',
  permission: 'inventory:read',
  columns: [
    { key: 'store', header: 'Store' },
    { key: 'sku', header: 'SKU' },
    { key: 'brand', header: 'Brand' },
    { key: 'product', header: 'Product' },
    { key: 'onHand', header: 'On hand' },
    { key: 'reserved', header: 'Reserved' },
    { key: 'available', header: 'Available' },
    { key: 'averageCost', header: 'Average cost (₹)' },
    { key: 'value', header: 'Value (₹)' },
  ],
  ...reportFilters({ ...store, inStockOnly: booleanFilter(true) }),
  query: (tx, auth, filters) =>
    tx
      .select({
        store: stores.code,
        sku: productVariants.sku,
        brand: brands.name,
        product: products.name,
        onHand: stockBalances.onHand,
        reserved: stockBalances.reserved,
        averageCost: stockBalances.avgCostPaise,
        value: sql<string | null>`round(${stockBalances.onHand} * ${stockBalances.avgCostPaise})`,
      })
      .from(stockBalances)
      .innerJoin(stores, eq(stores.id, stockBalances.storeId))
      .innerJoin(productVariants, eq(productVariants.id, stockBalances.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(
        and(
          storeScope(auth, stockBalances.storeId, filters.storeId),
          filters.inStockOnly ? sql`${stockBalances.onHand} > 0` : undefined,
        ),
      )
      .orderBy(asc(stores.code), asc(productVariants.sku))
      .$dynamic(),
  toRow: (r) => ({
    store: text(r.store),
    sku: text(r.sku),
    brand: text(r.brand),
    product: text(r.product),
    onHand: quantity(r.onHand),
    reserved: quantity(r.reserved),
    available: quantity(Number(r.onHand) - Number(r.reserved)),
    averageCost: rupees(r.averageCost),
    value: rupees(r.value),
  }),
};

const MOVEMENT_TYPES = schema.stockMovementType.enumValues;

const ledger: ReportKind<{
  storeId?: string;
  from?: string;
  to?: string;
  movementType?: (typeof MOVEMENT_TYPES)[number];
}> = {
  kind: 'stock-ledger',
  title: 'Stock ledger',
  permission: 'inventory:read',
  columns: [
    { key: 'at', header: 'Date' },
    { key: 'store', header: 'Store' },
    { key: 'sku', header: 'SKU' },
    { key: 'product', header: 'Product' },
    { key: 'type', header: 'Movement' },
    { key: 'quantity', header: 'Quantity' },
    { key: 'unitCost', header: 'Unit cost (₹)' },
    { key: 'note', header: 'Note' },
    { key: 'by', header: 'By' },
  ],
  ...reportFilters({ ...store, ...dateRange, movementType: enumFilter(MOVEMENT_TYPES) }),
  query: (tx, auth, filters) =>
    tx
      .select({
        at: ist(stockLedger.createdAt),
        store: stores.code,
        sku: productVariants.sku,
        product: products.name,
        type: stockLedger.movementType,
        quantity: stockLedger.quantity,
        unitCost: stockLedger.unitCostPaise,
        note: stockLedger.note,
        by: creatorUsers.fullName,
      })
      .from(stockLedger)
      .innerJoin(stores, eq(stores.id, stockLedger.storeId))
      .innerJoin(productVariants, eq(productVariants.id, stockLedger.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(creators, eq(creators.id, stockLedger.createdByMemberId))
      .leftJoin(creatorUsers, eq(creatorUsers.id, creators.userId))
      .where(
        and(
          storeScope(auth, stockLedger.storeId, filters.storeId),
          withinIndiaDays(stockLedger.createdAt, filters.from, filters.to),
          filters.movementType ? eq(stockLedger.movementType, filters.movementType) : undefined,
        ),
      )
      .orderBy(desc(stockLedger.createdAt), desc(stockLedger.id))
      .$dynamic(),
  toRow: (r) => ({
    at: text(r.at),
    store: text(r.store),
    sku: text(r.sku),
    product: text(r.product),
    type: text(r.type),
    quantity: quantity(r.quantity),
    unitCost: rupees(r.unitCost),
    note: text(r.note),
    by: text(r.by),
  }),
};

const TRANSFER_STATUSES = schema.transferStatus.enumValues;

const transferReport: ReportKind<{
  storeId?: string;
  from?: string;
  to?: string;
  status?: (typeof TRANSFER_STATUSES)[number];
}> = {
  kind: 'transfers',
  title: 'Transfers',
  permission: 'inventory:read',
  columns: [
    { key: 'number', header: 'Number' },
    { key: 'status', header: 'Status' },
    { key: 'from', header: 'From' },
    { key: 'to', header: 'To' },
    { key: 'requestedAt', header: 'Requested' },
    { key: 'dispatchedAt', header: 'Dispatched' },
    { key: 'receivedAt', header: 'Received' },
    { key: 'products', header: 'Products' },
    { key: 'value', header: 'Dispatched value (₹)' },
  ],
  ...reportFilters({ ...store, ...dateRange, status: enumFilter(TRANSFER_STATUSES) }),
  query: (tx, auth, filters) =>
    tx
      .select({
        number: transfers.number,
        status: transfers.status,
        from: fromStores.code,
        to: toStores.code,
        requestedAt: ist(transfers.requestedAt),
        dispatchedAt: ist(transfers.dispatchedAt),
        receivedAt: ist(transfers.receivedAt),
        products: sql<number>`(select count(*)::int from ${transferLines} where ${transferLines.transferId} = ${transfers.id})`,
        value: sql<
          string | null
        >`(select round(sum(${transferLines.dispatchedQuantity} * ${transferLines.unitCostPaise})) from ${transferLines} where ${transferLines.transferId} = ${transfers.id})`,
      })
      .from(transfers)
      .innerJoin(fromStores, eq(fromStores.id, transfers.fromStoreId))
      .innerJoin(toStores, eq(toStores.id, transfers.toStoreId))
      .where(
        and(
          or(
            storeScope(auth, transfers.fromStoreId, filters.storeId),
            storeScope(auth, transfers.toStoreId, filters.storeId),
          ),
          withinIndiaDays(transfers.requestedAt, filters.from, filters.to),
          filters.status ? eq(transfers.status, filters.status) : undefined,
        ),
      )
      .orderBy(desc(transfers.requestedAt), desc(transfers.number))
      .$dynamic(),
  toRow: (r) => ({
    number: text(r.number),
    status: text(r.status),
    from: text(r.from),
    to: text(r.to),
    requestedAt: text(r.requestedAt),
    dispatchedAt: text(r.dispatchedAt),
    receivedAt: text(r.receivedAt),
    products: Number(r.products),
    value: rupees(r.value),
  }),
};

const receipts: ReportKind<{ storeId?: string; from?: string; to?: string; supplierId?: string }> =
  {
    kind: 'goods-receipts',
    title: 'Goods receipts',
    permission: 'purchasing:read',
    columns: [
      { key: 'number', header: 'GRN' },
      { key: 'receivedAt', header: 'Received' },
      { key: 'store', header: 'Store' },
      { key: 'supplier', header: 'Supplier' },
      { key: 'invoice', header: 'Supplier invoice' },
      { key: 'invoiceDate', header: 'Invoice date' },
      { key: 'purchaseOrder', header: 'Purchase order' },
      { key: 'paidUnits', header: 'Paid units' },
      { key: 'freeUnits', header: 'Free units' },
      { key: 'value', header: 'Value (₹)' },
    ],
    ...reportFilters({ ...store, ...dateRange, supplierId: supplierFilter }),
    query: (tx, auth, filters) =>
      tx
        .select({
          number: goodsReceipts.number,
          receivedAt: ist(goodsReceipts.receivedAt),
          store: stores.code,
          supplier: parties.displayName,
          invoice: goodsReceipts.supplierInvoiceNumber,
          invoiceDate: goodsReceipts.supplierInvoiceDate,
          purchaseOrder: purchaseOrders.number,
          paidUnits: sql<string>`(select coalesce(sum(${goodsReceiptLines.quantity}), 0) from ${goodsReceiptLines} where ${goodsReceiptLines.goodsReceiptId} = ${goodsReceipts.id})`,
          freeUnits: sql<string>`(select coalesce(sum(${goodsReceiptLines.freeQuantity}), 0) from ${goodsReceiptLines} where ${goodsReceiptLines.goodsReceiptId} = ${goodsReceipts.id})`,
          value: sql<string>`(select coalesce(round(sum(${goodsReceiptLines.quantity} * ${goodsReceiptLines.unitCostPaise})), 0) from ${goodsReceiptLines} where ${goodsReceiptLines.goodsReceiptId} = ${goodsReceipts.id})`,
        })
        .from(goodsReceipts)
        .innerJoin(stores, eq(stores.id, goodsReceipts.storeId))
        .innerJoin(parties, eq(parties.id, goodsReceipts.supplierPartyId))
        .leftJoin(purchaseOrders, eq(purchaseOrders.id, goodsReceipts.purchaseOrderId))
        .where(
          and(
            storeScope(auth, goodsReceipts.storeId, filters.storeId),
            withinIndiaDays(goodsReceipts.receivedAt, filters.from, filters.to),
            filters.supplierId ? eq(goodsReceipts.supplierPartyId, filters.supplierId) : undefined,
          ),
        )
        .orderBy(desc(goodsReceipts.receivedAt), desc(goodsReceipts.number))
        .$dynamic(),
    toRow: (r) => ({
      number: text(r.number),
      receivedAt: text(r.receivedAt),
      store: text(r.store),
      supplier: text(r.supplier),
      invoice: text(r.invoice),
      invoiceDate: text(r.invoiceDate),
      purchaseOrder: text(r.purchaseOrder),
      paidUnits: quantity(r.paidUnits),
      freeUnits: quantity(r.freeUnits),
      value: rupees(r.value),
    }),
  };

const LEAD_STAGES = schema.leadStage.enumValues;
const LEAD_SOURCES = schema.leadSource.enumValues;

const leadReport: ReportKind<{
  storeId?: string;
  from?: string;
  to?: string;
  stage?: (typeof LEAD_STAGES)[number];
  source?: (typeof LEAD_SOURCES)[number];
}> = {
  kind: 'leads',
  title: 'Leads',
  permission: 'leads:read',
  columns: [
    { key: 'number', header: 'Lead' },
    { key: 'createdAt', header: 'Created' },
    { key: 'store', header: 'Store' },
    { key: 'title', header: 'Title' },
    { key: 'contact', header: 'Contact' },
    { key: 'phone', header: 'Mobile' },
    { key: 'source', header: 'Source' },
    { key: 'stage', header: 'Stage' },
    { key: 'estimatedValue', header: 'Estimated value (₹)' },
    { key: 'expectedOrderDate', header: 'Expected order' },
    { key: 'assignedTo', header: 'Assigned to' },
    { key: 'lostReason', header: 'Lost reason' },
  ],
  ...reportFilters({
    ...store,
    ...dateRange,
    stage: enumFilter(LEAD_STAGES),
    source: enumFilter(LEAD_SOURCES),
  }),
  query: (tx, auth, filters) =>
    tx
      .select({
        number: leads.number,
        createdAt: ist(leads.createdAt),
        store: stores.code,
        title: leads.title,
        contact: parties.displayName,
        phone: parties.phone,
        source: leads.source,
        stage: leads.stage,
        estimatedValue: leads.estimatedValuePaise,
        expectedOrderDate: leads.expectedOrderDate,
        assignedTo: assigneeUsers.fullName,
        lostReason: leads.lostReason,
      })
      .from(leads)
      .innerJoin(stores, eq(stores.id, leads.storeId))
      .innerJoin(parties, eq(parties.id, leads.partyId))
      .leftJoin(assignees, eq(assignees.id, leads.assignedMemberId))
      .leftJoin(assigneeUsers, eq(assigneeUsers.id, assignees.userId))
      .where(
        and(
          storeScope(auth, leads.storeId, filters.storeId),
          withinIndiaDays(leads.createdAt, filters.from, filters.to),
          filters.stage ? eq(leads.stage, filters.stage) : undefined,
          filters.source ? eq(leads.source, filters.source) : undefined,
        ),
      )
      .orderBy(desc(leads.createdAt), desc(leads.number))
      .$dynamic(),
  toRow: (r) => ({
    number: text(r.number),
    createdAt: text(r.createdAt),
    store: text(r.store),
    title: text(r.title),
    contact: text(r.contact),
    phone: text(r.phone),
    source: text(r.source),
    stage: text(r.stage),
    estimatedValue: rupees(r.estimatedValue),
    expectedOrderDate: text(r.expectedOrderDate),
    assignedTo: text(r.assignedTo),
    lostReason: text(r.lostReason),
  }),
};

const PROJECT_STAGES = schema.projectStage.enumValues;

const projectReport: ReportKind<{ storeId?: string; stage?: (typeof PROJECT_STAGES)[number] }> = {
  kind: 'projects',
  title: 'Projects',
  permission: 'projects:read',
  columns: [
    { key: 'number', header: 'Project' },
    { key: 'name', header: 'Name' },
    { key: 'store', header: 'Store' },
    { key: 'customer', header: 'Customer' },
    { key: 'city', header: 'City' },
    { key: 'stage', header: 'Stage' },
    { key: 'startDate', header: 'Start' },
    { key: 'expectedCompletion', header: 'Expected completion' },
    { key: 'areaSqFt', header: 'Area (sq ft)' },
    { key: 'paintLitres', header: 'Paint (litres)' },
    { key: 'expectedValue', header: 'Expected value (₹)' },
    { key: 'assignedTo', header: 'Assigned to' },
  ],
  ...reportFilters({ ...store, stage: enumFilter(PROJECT_STAGES) }),
  query: (tx, auth, filters) =>
    tx
      .select({
        number: projects.number,
        name: projects.name,
        store: stores.code,
        customer: parties.displayName,
        city: projects.city,
        stage: projects.stage,
        startDate: projects.startDate,
        expectedCompletion: projects.expectedCompletionDate,
        areaSqFt: projects.estimatedAreaSqFt,
        paintLitres: projects.estimatedPaintLitres,
        expectedValue: projects.expectedOrderValuePaise,
        assignedTo: assigneeUsers.fullName,
      })
      .from(projects)
      .innerJoin(stores, eq(stores.id, projects.storeId))
      .innerJoin(parties, eq(parties.id, projects.customerPartyId))
      .innerJoin(assignees, eq(assignees.id, projects.assignedMemberId))
      .innerJoin(assigneeUsers, eq(assigneeUsers.id, assignees.userId))
      .where(
        and(
          storeScope(auth, projects.storeId, filters.storeId),
          filters.stage ? eq(projects.stage, filters.stage) : undefined,
        ),
      )
      .orderBy(desc(projects.updatedAt), desc(projects.number))
      .$dynamic(),
  toRow: (r) => ({
    number: text(r.number),
    name: text(r.name),
    store: text(r.store),
    customer: text(r.customer),
    city: text(r.city),
    stage: text(r.stage),
    startDate: text(r.startDate),
    expectedCompletion: text(r.expectedCompletion),
    areaSqFt: quantity(r.areaSqFt),
    paintLitres: quantity(r.paintLitres),
    expectedValue: rupees(r.expectedValue),
    assignedTo: text(r.assignedTo),
  }),
};

export const REPORT_KINDS: readonly ReportKind<unknown>[] = [
  stockByLocation,
  ledger,
  transferReport,
  receipts,
  leadReport,
  projectReport,
];
