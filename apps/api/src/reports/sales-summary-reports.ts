import { schema } from '@paint/db';
import { variantName } from '@paint/shared';
import { and, asc, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { storeScope } from '../leads/crm-lookups.js';
import { dateFilter, enumFilter, reportFilters, storeFilter } from './report-filters.js';
import type { ReportKind } from './report-kinds.js';
import { rupees, text } from './report-values.js';
import {
  SALES_FILTERS,
  quantityCells,
  quantityColumns,
  quantityTotals,
  saleLineJoins,
  salesCells,
  salesColumns,
  salesTotals,
  salesWhere,
  type SalesFilters,
} from './sales-basis.js';

// The core sales reports (MVP 3 round 7b): by day, week or month, store, product, brand,
// category, salesperson and customer, all on one definition of a sale (sales-basis.ts), so
// each adds up to the same net sales; and money in by payment mode, as the day end counts it.

const {
  brands,
  categories,
  customerProfiles,
  organizationMembers,
  parties,
  paymentModes,
  payments,
  productVariants,
  products,
  stores,
  taxDocumentLines,
  taxDocuments,
  users,
} = schema;

const sales = reportFilters(SALES_FILTERS);

/** A group's share of the report's net sales, in percent to one decimal (0 when that is 0). */
const share = sql<string>`coalesce(round(100.0 * ${salesTotals.taxable} / nullif(sum(${salesTotals.taxable}) over (), 0), 1), 0)`;
const shareColumn = { key: 'share', header: 'Share of net sales (%)' } as const;
const shareCell = (r: Record<string, unknown>) => Number(r.share);

/** The sales columns without the average bill (for products, brands and categories). */
const valueColumns = salesColumns.filter((column) => column.key !== 'averageBill');

const valueCells = (r: Record<string, unknown>) => {
  const { averageBill: _, ...cells } = salesCells(r);
  return cells;
};

const INTERVALS = ['day', 'week', 'month'] as const;

/** The period a sale falls in: its day, the Monday of its week, or its month. */
function periodOf(interval: (typeof INTERVALS)[number] | undefined) {
  switch (interval) {
    case 'week':
      return sql<string>`to_char(date_trunc('week', ${taxDocuments.issuedOn}), 'YYYY-MM-DD')`;
    case 'month':
      return sql<string>`to_char(${taxDocuments.issuedOn}, 'YYYY-MM')`;
    default:
      return sql<string>`to_char(${taxDocuments.issuedOn}, 'YYYY-MM-DD')`;
  }
}

/** Net sales per day (or week, or month), newest first. */
export const salesByPeriod: ReportKind<SalesFilters & { interval?: (typeof INTERVALS)[number] }> = {
  kind: 'sales-by-period',
  title: 'Sales by day',
  permission: 'sales:read',
  columns: [{ key: 'period', header: 'Day, week (from Monday) or month' }, ...salesColumns],
  ...reportFilters({ interval: enumFilter(INTERVALS), ...SALES_FILTERS }),
  query: (tx, auth, filters) => {
    const period = periodOf(filters.interval);
    return tx
      .select({ period, ...salesTotals })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, saleLineJoins.document)
      .innerJoin(productVariants, saleLineJoins.variant)
      .innerJoin(products, saleLineJoins.product)
      .where(salesWhere(auth, filters))
      .groupBy(period)
      .orderBy(desc(period))
      .$dynamic();
  },
  toRow: (r) => ({ period: text(r.period), ...salesCells(r) }),
};

/** Net sales per store, the biggest first. */
export const salesByStore: ReportKind<SalesFilters> = {
  kind: 'sales-by-store',
  title: 'Sales by store',
  permission: 'sales:read',
  columns: [
    { key: 'store', header: 'Store' },
    { key: 'name', header: 'Name' },
    { key: 'gstin', header: 'GSTIN' },
    ...salesColumns,
    shareColumn,
  ],
  ...sales,
  query: (tx, auth, filters) =>
    tx
      .select({ store: stores.code, name: stores.name, gstin: stores.gstin, ...salesTotals, share })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, saleLineJoins.document)
      .innerJoin(productVariants, saleLineJoins.variant)
      .innerJoin(products, saleLineJoins.product)
      .innerJoin(stores, eq(stores.id, taxDocuments.storeId))
      .where(salesWhere(auth, filters))
      .groupBy(stores.id)
      .orderBy(desc(salesTotals.taxable), asc(stores.code))
      .$dynamic(),
  toRow: (r) => ({
    store: text(r.store),
    name: text(r.name),
    gstin: text(r.gstin),
    ...salesCells(r),
    share: shareCell(r),
  }),
};

/** Net sales per pack (variant), with units and litres, the biggest first. */
export const salesByProduct: ReportKind<SalesFilters> = {
  kind: 'sales-by-product',
  title: 'Sales by product',
  permission: 'sales:read',
  columns: [
    { key: 'sku', header: 'SKU' },
    { key: 'brand', header: 'Brand' },
    { key: 'product', header: 'Product' },
    { key: 'variant', header: 'Size / pack' },
    { key: 'category', header: 'Category' },
    ...quantityColumns,
    ...valueColumns,
    shareColumn,
  ],
  ...sales,
  query: (tx, auth, filters) =>
    tx
      .select({
        sku: productVariants.sku,
        brand: brands.name,
        product: products.name,
        packSize: productVariants.packSize,
        unit: productVariants.unit,
        label: productVariants.label,
        category: categories.name,
        ...quantityTotals,
        ...salesTotals,
        share,
      })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, saleLineJoins.document)
      .innerJoin(productVariants, saleLineJoins.variant)
      .innerJoin(products, saleLineJoins.product)
      .innerJoin(brands, eq(brands.id, products.brandId))
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(salesWhere(auth, filters))
      .groupBy(productVariants.id, products.id, brands.id, categories.id)
      .orderBy(desc(salesTotals.taxable), asc(productVariants.sku))
      .$dynamic(),
  toRow: (r) => ({
    sku: text(r.sku),
    brand: text(r.brand),
    product: text(r.product),
    variant: variantName({
      packSize: Number(r.packSize),
      unit: String(r.unit),
      label: text(r.label),
    }),
    category: text(r.category),
    ...quantityCells(r),
    ...valueCells(r),
    share: shareCell(r),
  }),
};

const groupColumns = [
  { key: 'products', header: 'Packs sold' },
  ...quantityColumns,
  ...valueColumns,
  shareColumn,
];
const packsSold = sql<number>`count(distinct ${productVariants.id})::int`;
const groupCells = (r: Record<string, unknown>) => ({
  products: Number(r.products),
  ...quantityCells(r),
  ...valueCells(r),
  share: shareCell(r),
});

/** Net sales per brand, the biggest first. */
export const salesByBrand: ReportKind<SalesFilters> = {
  kind: 'sales-by-brand',
  title: 'Sales by brand',
  permission: 'sales:read',
  columns: [{ key: 'brand', header: 'Brand' }, ...groupColumns],
  ...sales,
  query: (tx, auth, filters) =>
    tx
      .select({ brand: brands.name, products: packsSold, ...quantityTotals, ...salesTotals, share })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, saleLineJoins.document)
      .innerJoin(productVariants, saleLineJoins.variant)
      .innerJoin(products, saleLineJoins.product)
      .innerJoin(brands, eq(brands.id, products.brandId))
      .where(salesWhere(auth, filters))
      .groupBy(brands.id)
      .orderBy(desc(salesTotals.taxable), asc(brands.name))
      .$dynamic(),
  toRow: (r) => ({ brand: text(r.brand), ...groupCells(r) }),
};

/** Net sales per product category (none for uncategorised products), the biggest first. */
export const salesByCategory: ReportKind<SalesFilters> = {
  kind: 'sales-by-category',
  title: 'Sales by category',
  permission: 'sales:read',
  columns: [{ key: 'category', header: 'Category' }, ...groupColumns],
  ...sales,
  query: (tx, auth, filters) =>
    tx
      .select({
        category: categories.name,
        products: packsSold,
        ...quantityTotals,
        ...salesTotals,
        share,
      })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, saleLineJoins.document)
      .innerJoin(productVariants, saleLineJoins.variant)
      .innerJoin(products, saleLineJoins.product)
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(salesWhere(auth, filters))
      .groupBy(categories.id)
      .orderBy(desc(salesTotals.taxable), asc(categories.name))
      .$dynamic(),
  toRow: (r) => ({ category: text(r.category), ...groupCells(r) }),
};

/**
 * Net sales per salesperson: the member who issued each bill or note (a note counts
 * against whoever issued the note). The customer's assigned salesperson is a filter.
 */
export const salesBySalesperson: ReportKind<SalesFilters> = {
  kind: 'sales-by-salesperson',
  title: 'Sales by salesperson',
  permission: 'sales:read',
  columns: [
    { key: 'salesperson', header: 'Salesperson (issued the bill)' },
    { key: 'customers', header: 'Customers' },
    ...salesColumns,
    shareColumn,
  ],
  ...sales,
  query: (tx, auth, filters) =>
    tx
      .select({
        salesperson: users.fullName,
        customers: sql<number>`count(distinct ${taxDocuments.partyId})::int`,
        ...salesTotals,
        share,
      })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, saleLineJoins.document)
      .innerJoin(productVariants, saleLineJoins.variant)
      .innerJoin(products, saleLineJoins.product)
      .innerJoin(organizationMembers, eq(organizationMembers.id, taxDocuments.issuedByMemberId))
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(salesWhere(auth, filters))
      .groupBy(organizationMembers.id, users.id)
      .orderBy(desc(salesTotals.taxable), asc(users.fullName))
      .$dynamic(),
  toRow: (r) => ({
    salesperson: text(r.salesperson),
    customers: Number(r.customers),
    ...salesCells(r),
    share: shareCell(r),
  }),
};

/** Net sales per customer, the biggest first (walk-in sales are the walk-in customer's). */
export const salesByCustomer: ReportKind<SalesFilters> = {
  kind: 'sales-by-customer',
  title: 'Sales by customer',
  permission: 'sales:read',
  columns: [
    { key: 'customer', header: 'Customer' },
    { key: 'phone', header: 'Mobile' },
    { key: 'customerType', header: 'Customer type' },
    { key: 'gstin', header: 'GSTIN' },
    { key: 'lastBilled', header: 'Last billed' },
    ...salesColumns,
    shareColumn,
  ],
  ...sales,
  query: (tx, auth, filters) =>
    tx
      .select({
        customer: sql<
          string | null
        >`coalesce(${parties.displayName}, max(${taxDocuments.buyerName}))`,
        phone: parties.phone,
        customerType: customerProfiles.customerType,
        gstin: parties.gstin,
        lastBilled: sql<string>`max(${taxDocuments.issuedOn})::text`,
        ...salesTotals,
        share,
      })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, saleLineJoins.document)
      .innerJoin(productVariants, saleLineJoins.variant)
      .innerJoin(products, saleLineJoins.product)
      .leftJoin(parties, eq(parties.id, taxDocuments.partyId))
      .leftJoin(customerProfiles, eq(customerProfiles.partyId, taxDocuments.partyId))
      .where(salesWhere(auth, filters))
      .groupBy(parties.id, customerProfiles.partyId)
      .orderBy(desc(salesTotals.taxable), asc(parties.displayName))
      .$dynamic(),
  toRow: (r) => ({
    customer: text(r.customer),
    phone: text(r.phone),
    customerType: text(r.customerType),
    gstin: text(r.gstin),
    lastBilled: text(r.lastBilled),
    ...salesCells(r),
    share: shareCell(r),
  }),
};

const MODE_KINDS = schema.paymentModeKind.enumValues;
const money = (condition: ReturnType<typeof sql>) =>
  sql<string>`coalesce(sum(${payments.amountPaise}) filter (where ${condition}), 0)`;
const moneyIn = sql`${payments.direction} = 'in'`;

/**
 * Money in and out per day, store and payment mode, as the day end counts it: every
 * payment on the day it was received, a cheque that later bounced included (its bounce
 * is shown beside it, on the day it was received); refunds paid out take away.
 */
export const paymentsByMode: ReportKind<{
  storeId?: string;
  from?: string;
  to?: string;
  modeKind?: (typeof MODE_KINDS)[number];
}> = {
  kind: 'payments-by-mode',
  title: 'Collections by payment mode',
  permission: 'sales:read',
  columns: [
    { key: 'day', header: 'Date' },
    { key: 'store', header: 'Store' },
    { key: 'mode', header: 'Payment mode' },
    { key: 'modeKind', header: 'Kind' },
    { key: 'payments', header: 'Payments' },
    { key: 'received', header: 'Received (₹)' },
    { key: 'atCounter', header: 'Of which at a counter (₹)' },
    { key: 'refunded', header: 'Refunded (₹)' },
    { key: 'net', header: 'Net (₹)' },
    { key: 'bounced', header: 'Cheques bounced since (₹)' },
  ],
  ...reportFilters({
    storeId: storeFilter,
    from: dateFilter,
    to: dateFilter,
    modeKind: enumFilter(MODE_KINDS),
  }),
  query: (tx, auth, filters) =>
    tx
      .select({
        day: sql<string>`${payments.receivedOn}::text`,
        store: stores.code,
        mode: paymentModes.name,
        modeKind: payments.modeKind,
        payments: sql<number>`count(*)::int`,
        received: money(moneyIn),
        atCounter: money(sql`${moneyIn} and ${payments.registerSessionId} is not null`),
        refunded: money(sql`${payments.direction} = 'out'`),
        bounced: money(sql`${payments.chequeStatus} = 'bounced'`),
      })
      .from(payments)
      .innerJoin(stores, eq(stores.id, payments.storeId))
      .innerJoin(paymentModes, eq(paymentModes.id, payments.modeId))
      .where(
        and(
          storeScope(auth, payments.storeId, filters.storeId),
          filters.from ? gte(payments.receivedOn, filters.from) : undefined,
          filters.to ? lte(payments.receivedOn, filters.to) : undefined,
          filters.modeKind ? eq(payments.modeKind, filters.modeKind) : undefined,
        ),
      )
      .groupBy(payments.receivedOn, stores.id, paymentModes.id, payments.modeKind)
      .orderBy(desc(payments.receivedOn), asc(stores.code), asc(paymentModes.name))
      .$dynamic(),
  toRow: (r) => ({
    day: text(r.day),
    store: text(r.store),
    mode: text(r.mode),
    modeKind: text(r.modeKind),
    payments: Number(r.payments),
    received: rupees(r.received),
    atCounter: rupees(r.atCounter),
    refunded: rupees(r.refunded),
    net: rupees(Number(r.received) - Number(r.refunded)),
    bounced: rupees(r.bounced),
  }),
};

export const SALES_REPORT_KINDS = [
  salesByPeriod,
  salesByStore,
  salesByProduct,
  salesByBrand,
  salesByCategory,
  salesBySalesperson,
  salesByCustomer,
  paymentsByMode,
] as const;
