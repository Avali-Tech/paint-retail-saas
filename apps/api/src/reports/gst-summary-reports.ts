import { schema } from '@paint/db';
import { and, asc, eq, gte, inArray, lte, sql, type AnyColumn } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { storeScope } from '../leads/crm-lookups.js';
import { dateFilter, reportFilters, storeFilter } from './report-filters.js';
import type { ReportKind } from './report-kinds.js';
import { quantity, rupees, text } from './report-values.js';
import { SALE_KINDS, saleSign } from './sales-basis.js';

// The GST summary (MVP 3 round 7b): a period's outward supplies per GSTIN, from the issued
// documents' lines, credit notes netted and debit notes added on their own issue dates,
// cancelled documents left out. Not a GSTR-1 filing export (Release 2.3); it reconciles
// exactly with the documents and with the Tally export of the same period.

const { stores, taxDocumentLines, taxDocuments } = schema;

interface GstFilters {
  storeId?: string;
  from?: string;
  to?: string;
}

const gstFilters = reportFilters({ storeId: storeFilter, from: dateFilter, to: dateFilter });

/**
 * A line's place in the summary: its GST nature as issued (taxable, nil-rated, exempt,
 * non-GST), or "bill_of_supply" for a composition dealer's bill of supply and its notes,
 * which carry no rate.
 */
const section = sql<string>`coalesce(${taxDocumentLines.taxNature}::text, 'bill_of_supply')`;
const SECTION_ORDER = sql`array_position(array['taxable', 'nil_rated', 'exempt', 'non_gst', 'bill_of_supply'], ${section})`;
const rate = sql<number>`coalesce(${taxDocumentLines.rateBps}, 0)`;
const cessRate = sql<number>`coalesce(${taxDocumentLines.cessBps}, 0)`;
/** B2B when the buyer gave a GSTIN; B2C (large or small) otherwise. */
const buyerType = sql<string>`(case when ${taxDocuments.gstClass} = 'b2b' then 'b2b' else 'b2c' end)`;

const net = (column: AnyColumn) => sql<string>`sum(${saleSign} * ${column})`;
const heads = {
  taxable: net(taxDocumentLines.taxablePaise),
  cgst: net(taxDocumentLines.cgstPaise),
  sgst: net(taxDocumentLines.sgstPaise),
  igst: net(taxDocumentLines.igstPaise),
  cess: net(taxDocumentLines.cessPaise),
};
const headColumns = [
  { key: 'taxable', header: 'Taxable value (₹)' },
  { key: 'cgst', header: 'CGST (₹)' },
  { key: 'sgst', header: 'SGST / UTGST (₹)' },
  { key: 'igst', header: 'IGST (₹)' },
  { key: 'cess', header: 'Cess (₹)' },
  { key: 'tax', header: 'Total tax (₹)' },
] as const;
const headCells = (r: Record<string, unknown>) => ({
  taxable: rupees(r.taxable),
  cgst: rupees(r.cgst),
  sgst: rupees(r.sgst),
  igst: rupees(r.igst),
  cess: rupees(r.cess),
  tax: rupees(Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess)),
});

/** Issued sale documents of the period at the member's stores. */
function issuedInPeriod(auth: AuthContext, filters: GstFilters) {
  return and(
    eq(taxDocuments.status, 'issued'),
    inArray(taxDocuments.kind, [...SALE_KINDS]),
    storeScope(auth, taxDocuments.storeId, filters.storeId),
    filters.from ? gte(taxDocuments.issuedOn, filters.from) : undefined,
    filters.to ? lte(taxDocuments.issuedOn, filters.to) : undefined,
  );
}

const percent = (basisPoints: unknown) => Number(basisPoints) / 100;

/** Taxable value and tax per GSTIN, nature, rate, B2B or B2C, and intra- or inter-state. */
export const gstSummary: ReportKind<GstFilters> = {
  kind: 'gst-summary',
  title: 'GST summary',
  permission: 'accounting:export',
  columns: [
    { key: 'gstin', header: 'Our GSTIN' },
    { key: 'stores', header: 'Stores' },
    { key: 'section', header: 'Supply' },
    { key: 'rate', header: 'GST rate (%)' },
    { key: 'cessRate', header: 'Cess rate (%)' },
    { key: 'buyerType', header: 'B2B / B2C' },
    { key: 'supplyType', header: 'Intra / inter-state' },
    { key: 'documents', header: 'Documents' },
    { key: 'creditNotes', header: 'Of which credit notes' },
    ...headColumns,
  ],
  ...gstFilters,
  query: (tx, auth, filters) =>
    tx
      .select({
        gstin: taxDocuments.supplierGstin,
        stores: sql<string>`string_agg(distinct ${stores.code}, ', ' order by ${stores.code})`,
        section,
        rate,
        cessRate,
        buyerType,
        supplyType: taxDocuments.supplyType,
        documents: sql<number>`count(distinct ${taxDocuments.id})::int`,
        creditNotes: sql<number>`(count(distinct ${taxDocuments.id}) filter (where ${taxDocuments.kind} = 'credit_note'))::int`,
        ...heads,
      })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, eq(taxDocuments.id, taxDocumentLines.documentId))
      .innerJoin(stores, eq(stores.id, taxDocuments.storeId))
      .where(issuedInPeriod(auth, filters))
      .groupBy(
        taxDocuments.supplierGstin,
        section,
        rate,
        cessRate,
        buyerType,
        taxDocuments.supplyType,
      )
      .orderBy(
        asc(taxDocuments.supplierGstin),
        SECTION_ORDER,
        asc(rate),
        asc(cessRate),
        asc(buyerType),
        asc(taxDocuments.supplyType),
      )
      .$dynamic(),
  toRow: (r) => ({
    gstin: text(r.gstin),
    stores: text(r.stores),
    section: text(r.section),
    rate: percent(r.rate),
    cessRate: percent(r.cessRate),
    buyerType: text(r.buyerType),
    supplyType: text(r.supplyType),
    documents: Number(r.documents),
    creditNotes: Number(r.creditNotes),
    ...headCells(r),
  }),
};

/** Quantities: what bills sold less what credit notes took back (value notes move none). */
const netQuantity = sql<string>`sum((case when ${taxDocuments.kind} in ('invoice', 'bill_of_supply') then 1
  when ${taxDocuments.kind} = 'credit_note' and ${taxDocuments.stockPosting} <> 'none' then -1
  else 0 end) * ${taxDocumentLines.quantity})`;

/** The same supplies per GSTIN, HSN code, unit and rate (the HSN-wise view). */
export const gstHsnSummary: ReportKind<GstFilters> = {
  kind: 'gst-hsn-summary',
  title: 'GST summary by HSN',
  permission: 'accounting:export',
  columns: [
    { key: 'gstin', header: 'Our GSTIN' },
    { key: 'hsn', header: 'HSN' },
    { key: 'uqc', header: 'Unit (UQC)' },
    { key: 'section', header: 'Supply' },
    { key: 'rate', header: 'GST rate (%)' },
    { key: 'quantity', header: 'Quantity (net)' },
    ...headColumns,
    { key: 'value', header: 'Total value (₹)' },
  ],
  ...gstFilters,
  query: (tx, auth, filters) =>
    tx
      .select({
        gstin: taxDocuments.supplierGstin,
        hsn: taxDocumentLines.hsnCode,
        uqc: taxDocumentLines.uqc,
        section,
        rate,
        quantity: netQuantity,
        ...heads,
      })
      .from(taxDocumentLines)
      .innerJoin(taxDocuments, eq(taxDocuments.id, taxDocumentLines.documentId))
      .where(issuedInPeriod(auth, filters))
      .groupBy(
        taxDocuments.supplierGstin,
        taxDocumentLines.hsnCode,
        taxDocumentLines.uqc,
        section,
        rate,
      )
      .orderBy(
        asc(taxDocuments.supplierGstin),
        asc(taxDocumentLines.hsnCode),
        asc(taxDocumentLines.uqc),
        SECTION_ORDER,
        asc(rate),
      )
      .$dynamic(),
  toRow: (r) => {
    const cells = headCells(r);
    return {
      gstin: text(r.gstin),
      hsn: text(r.hsn),
      uqc: text(r.uqc),
      section: text(r.section),
      rate: percent(r.rate),
      quantity: quantity(r.quantity),
      ...cells,
      value: rupees(
        Number(r.taxable) + Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess),
      ),
    };
  },
};
