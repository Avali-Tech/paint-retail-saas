import { schema } from '@paint/db';
import { and, eq, gte, ilike, inArray, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { storeScope } from '../leads/crm-lookups.js';
import { containsPattern } from '../parties/party-access.js';
import {
  brandFilter,
  categoryFilter,
  dateFilter,
  enumFilter,
  memberFilter,
  storeFilter,
  textFilter,
} from './report-filters.js';
import { quantity, rupees } from './report-values.js';

// What "sales" means in every sales report, the dashboard's sales tile and the GST summary
// (MVP 3 round 7b, docs/mvp-3/sales-reports.md):
//
// - issued invoices, bills of supply and debit notes add; issued credit notes take away;
// - each document counts on its own issue date (an India-time day), a note included;
// - drafts never count, and a cancelled document never counts at all (a cancelled invoice
//   is as if never issued, which is how GST and the Tally export treat it);
// - values come from the document lines (taxable value, GST and cess as issued), so a
//   report by product adds up to the report by day: lines sum to their document exactly,
//   bill discounts included. Round-off is left out (it belongs to no line).
// - quantities: bills add what they sold, credit notes for goods returned take it back,
//   and value-only notes (a discount, an overcharge) and debit notes move no quantity.

const { customerProfiles, productVariants, products, taxDocumentLines, taxDocuments } = schema;

export const SALE_KINDS = ['invoice', 'bill_of_supply', 'debit_note', 'credit_note'] as const;
export type SaleKind = (typeof SALE_KINDS)[number];
export const BUYER_TYPES = ['b2b', 'b2c'] as const;
export const CUSTOMER_TYPES = schema.customerType.enumValues;

export interface SalesFilters {
  storeId?: string;
  from?: string;
  to?: string;
  kind?: SaleKind;
  buyerType?: (typeof BUYER_TYPES)[number];
  customerType?: (typeof CUSTOMER_TYPES)[number];
  /** The member who issued the bill. */
  salespersonId?: string;
  /** The salesperson assigned to the customer (their customer profile). */
  customerSalespersonId?: string;
  brandId?: string;
  categoryId?: string;
  /** Part of a product's name or a pack's SKU. */
  product?: string;
}

/** Every sales report's filters, in the order the app shows them. */
export const SALES_FILTERS = {
  storeId: storeFilter,
  from: dateFilter,
  to: dateFilter,
  kind: enumFilter(SALE_KINDS),
  buyerType: enumFilter(BUYER_TYPES),
  customerType: enumFilter(CUSTOMER_TYPES),
  salespersonId: memberFilter,
  customerSalespersonId: memberFilter,
  brandId: brandFilter,
  categoryId: categoryFilter,
  product: textFilter,
};

/** +1 for a sale (invoice, bill of supply, debit note), −1 for a credit note. */
export const saleSign = sql`(case when ${taxDocuments.kind} = 'credit_note' then -1 else 1 end)`;

/** +1 for a bill, −1 for a credit note that took goods back, 0 for value-only notes. */
const quantitySign = sql`(case when ${taxDocuments.kind} in ('invoice', 'bill_of_supply') then 1
  when ${taxDocuments.kind} = 'credit_note' and ${taxDocuments.stockPosting} <> 'none' then -1
  else 0 end)`;

const lineTax = sql`(${taxDocumentLines.cgstPaise} + ${taxDocumentLines.sgstPaise} + ${taxDocumentLines.igstPaise} + ${taxDocumentLines.cessPaise})`;
const isBill = sql`${taxDocuments.kind} in ('invoice', 'bill_of_supply')`;

/** A line's litres: its quantity of packs times the pack in litres; null for other units. */
const lineLitres = sql`(case ${productVariants.unit} when 'l' then ${taxDocumentLines.quantity} * ${productVariants.packSize}
  when 'ml' then ${taxDocumentLines.quantity} * ${productVariants.packSize} / 1000 end)`;

/** The figures every sales report adds up, over the lines of its group. */
export const salesTotals = {
  bills: sql<number>`(count(distinct ${taxDocuments.id}) filter (where ${isBill}))::int`,
  creditNotes: sql<number>`(count(distinct ${taxDocuments.id}) filter (where ${taxDocuments.kind} = 'credit_note'))::int`,
  billsTaxable: sql<string>`coalesce(sum(${taxDocumentLines.taxablePaise}) filter (where ${isBill}), 0)`,
  taxable: sql<string>`sum(${saleSign} * ${taxDocumentLines.taxablePaise})`,
  tax: sql<string>`sum(${saleSign} * ${lineTax})`,
};

/** Units and litres, for reports by product, brand or category. */
export const quantityTotals = {
  quantity: sql<string>`sum(${quantitySign} * ${taxDocumentLines.quantity})`,
  litres: sql<string | null>`sum(${quantitySign} * ${lineLitres})`,
};

export const salesColumns = [
  { key: 'bills', header: 'Bills' },
  { key: 'creditNotes', header: 'Credit notes' },
  { key: 'taxable', header: 'Net sales (₹, before GST)' },
  { key: 'tax', header: 'GST (₹)' },
  { key: 'value', header: 'Net sales with GST (₹)' },
  { key: 'averageBill', header: 'Average bill (₹, before GST)' },
] as const;

export const quantityColumns = [
  { key: 'quantity', header: 'Quantity (net)' },
  { key: 'litres', header: 'Litres (net)' },
] as const;

export function salesCells(r: Record<string, unknown>) {
  const bills = Number(r.bills);
  return {
    bills,
    creditNotes: Number(r.creditNotes),
    taxable: rupees(r.taxable),
    tax: rupees(r.tax),
    value: rupees(Number(r.taxable) + Number(r.tax)),
    averageBill: bills === 0 ? null : rupees(Number(r.billsTaxable) / bills),
  };
}

export function quantityCells(r: Record<string, unknown>) {
  return { quantity: quantity(r.quantity), litres: quantity(r.litres) };
}

/** The customer's profile says so (walk-in sales have the walk-in party's profile). */
const profile = (condition: SQL) =>
  sql`exists (select 1 from ${customerProfiles} where ${customerProfiles.partyId} = ${taxDocuments.partyId} and ${condition})`;

/**
 * The sale lines a sales report reads: lines of issued sale documents at the member's
 * stores, joined to their pack and product, within the filters.
 */
export function salesWhere(auth: AuthContext, filters: SalesFilters): SQL | undefined {
  return and(
    eq(taxDocuments.status, 'issued'),
    inArray(taxDocuments.kind, filters.kind ? [filters.kind] : [...SALE_KINDS]),
    storeScope(auth, taxDocuments.storeId, filters.storeId),
    filters.from ? gte(taxDocuments.issuedOn, filters.from) : undefined,
    filters.to ? lte(taxDocuments.issuedOn, filters.to) : undefined,
    filters.buyerType === undefined
      ? undefined
      : filters.buyerType === 'b2b'
        ? eq(taxDocuments.gstClass, 'b2b')
        : ne(taxDocuments.gstClass, 'b2b'),
    filters.customerType
      ? profile(eq(customerProfiles.customerType, filters.customerType))
      : undefined,
    filters.salespersonId ? eq(taxDocuments.issuedByMemberId, filters.salespersonId) : undefined,
    filters.customerSalespersonId
      ? profile(eq(customerProfiles.assignedMemberId, filters.customerSalespersonId))
      : undefined,
    filters.brandId ? eq(products.brandId, filters.brandId) : undefined,
    filters.categoryId ? eq(products.categoryId, filters.categoryId) : undefined,
    filters.product
      ? or(
          ilike(products.name, containsPattern(filters.product)),
          ilike(productVariants.sku, containsPattern(filters.product)),
        )
      : undefined,
  );
}

/** Joins every sales report makes: line → document, pack, product. */
export const saleLineJoins = {
  document: eq(taxDocuments.id, taxDocumentLines.documentId),
  variant: eq(productVariants.id, taxDocumentLines.variantId),
  product: eq(products.id, productVariants.productId),
};
