import { hsnMeetsRequirement, requiredHsnDigits } from '../gst/hsn.js';
import { at } from '../gst/arith.js';
import type { Invoice } from '../gst/invoice.js';
import { formatINR } from '../money.js';
import {
  addressLines,
  formatAmount,
  formatPrintDate,
  formatQuantity,
  formatRate,
  stateLabel,
} from './format.js';
import { LEGAL_TEXTS, fillLabel, invoiceLabels, type InvoiceLabels } from './labels.js';
import type {
  GstClass,
  InvoiceDocumentInput,
  InvoiceView,
  PrintIssue,
  PrintRequirements,
  TaxColumnKey,
  TotalRow,
} from './types.js';

export type InvoicePrintErrorCode = 'kind_mismatch' | 'buyer_mismatch' | 'line_mismatch';

/** The document data does not belong to the engine's invoice: a programming error, not a missing field. */
export class InvoicePrintError extends Error {
  override readonly name = 'InvoicePrintError';

  constructor(
    readonly code: InvoicePrintErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Rule 46(e): an unregistered buyer's details are mandatory from ₹50,000 of taxable value. */
export const UNREGISTERED_DETAILS_FROM_PAISE = 50_000_00;
/** Rule 59(4)(a)(ii): B2C large is inter-state above ₹1,00,000 of invoice value. */
export const B2C_LARGE_ABOVE_PAISE = 1_00_000_00;
/** Rule 46(b): consecutive serial of up to 16 letters, digits, "-" or "/". */
const NUMBER_FORMAT = /^[A-Z0-9/-]{1,16}$/;

/** Which Rule 46 / 49 fields this invoice must carry, by buyer, value, turnover and kind. */
export function printRequirements(
  invoice: Invoice,
  aggregateTurnoverPaise: number,
): PrintRequirements {
  const b2b = invoice.buyerType === 'b2b';
  const large = !b2b && invoice.totals.taxablePaise >= UNREGISTERED_DETAILS_FROM_PAISE;
  const taxInvoice = invoice.documentType === 'tax_invoice';
  return {
    buyerGstin: b2b,
    buyerDetails: b2b || large,
    deliveryAddress: large,
    hsnDigits: requiredHsnDigits(aggregateTurnoverPaise, invoice.buyerType),
    placeOfSupply: invoice.supplyType === 'inter_state',
    reverseChargeLine: taxInvoice,
    compositionNotice: !taxInvoice,
  };
}

/** The mandatory fields the document lacks; empty when it is complete. */
export function printIssues(
  document: InvoiceDocumentInput,
  requirements: PrintRequirements,
): PrintIssue[] {
  const issues: PrintIssue[] = [];
  const issue = (code: PrintIssue['code'], clause: string, line: number | null = null) => {
    issues.push({ code, clause, line });
  };
  if (!NUMBER_FORMAT.test(document.number)) issue('number_format', '46(b)');
  const detailsClause = requirements.buyerGstin ? '46(d)' : '46(e)';
  if (requirements.buyerDetails && (document.buyer.name ?? '').trim() === '') {
    issue('buyer_name', detailsClause);
  }
  if (requirements.buyerDetails && document.buyer.address === null) {
    issue('buyer_address', detailsClause);
  }
  if (requirements.deliveryAddress && (document.shipTo ?? document.buyer.address) === null) {
    issue('delivery_address', '46(e)');
  }
  document.lines.forEach((line, index) => {
    if (!hsnMeetsRequirement(line.hsnCode, requirements.hsnDigits)) {
      issue('hsn_digits', '46(g)', index);
    }
  });
  return issues;
}

function gstClassOf(invoice: Invoice): GstClass {
  if (invoice.buyerType === 'b2b') return 'b2b';
  const large =
    invoice.supplyType === 'inter_state' && invoice.totals.payablePaise > B2C_LARGE_ABOVE_PAISE;
  return large ? 'b2cl' : 'b2cs';
}

const HEAD_PAISE = {
  cgst: 'cgstPaise',
  sgst: 'sgstPaise',
  igst: 'igstPaise',
  cess: 'cessPaise',
} as const satisfies Record<TaxColumnKey, string>;

function taxColumns(invoice: Invoice): { key: TaxColumnKey; label: string }[] {
  if (invoice.documentType === 'bill_of_supply') return [];
  const columns: { key: TaxColumnKey; label: string }[] =
    invoice.supplyType === 'intra_state'
      ? [
          { key: 'cgst', label: 'CGST' },
          { key: 'sgst', label: invoice.stateTaxLabel },
        ]
      : [{ key: 'igst', label: 'IGST' }];
  if (invoice.totals.cessPaise > 0) columns.push({ key: 'cess', label: 'Cess' });
  return columns;
}

function totalRows(
  invoice: Invoice,
  labels: InvoiceLabels,
  columns: readonly { key: TaxColumnKey; label: string }[],
): TotalRow[] {
  const { totals } = invoice;
  const discountPaise = totals.lineDiscountPaise + totals.invoiceDiscountPaise;
  const rows: TotalRow[] = [];
  if (discountPaise > 0) {
    rows.push({ key: 'discount', label: labels.discount, amount: formatAmount(-discountPaise) });
  }
  const subtotalLabel = columns.length > 0 ? labels.taxableValue : labels.value;
  rows.push({ key: 'subtotal', label: subtotalLabel, amount: formatAmount(totals.taxablePaise) });
  for (const column of columns) {
    rows.push({
      key: column.key,
      label: { text: column.label, translation: null },
      amount: formatAmount(totals[HEAD_PAISE[column.key]]),
    });
  }
  rows.push({
    key: 'roundOff',
    label: labels.roundOff,
    amount: formatAmount(totals.roundOffPaise),
  });
  rows.push({
    key: 'grandTotal',
    label: labels.grandTotal,
    amount: formatAmount(totals.payablePaise),
  });
  return rows;
}

/**
 * The print-ready invoice: the engine's `Invoice` (amounts, tax, round-off, words)
 * with the document's header data, every value formatted, the Rule 46 fields this
 * case needs and those it lacks. Both templates and the PDF render only this.
 */
export function buildInvoiceView(invoice: Invoice, document: InvoiceDocumentInput): InvoiceView {
  if (document.kind !== invoice.documentType) {
    throw new InvoicePrintError(
      'kind_mismatch',
      `A ${invoice.documentType} cannot print as a ${document.kind}`,
    );
  }
  if ((document.buyer.gstin !== null) !== (invoice.buyerType === 'b2b')) {
    throw new InvoicePrintError(
      'buyer_mismatch',
      'The buyer GSTIN must be given exactly when the invoice is B2B',
    );
  }
  if (document.lines.length !== invoice.lines.length) {
    throw new InvoicePrintError(
      'line_mismatch',
      `The invoice has ${String(invoice.lines.length)} lines, the document ${String(document.lines.length)}`,
    );
  }
  const labels = invoiceLabels(document.secondLanguage);
  const requirements = printRequirements(invoice, document.aggregateTurnoverPaise);
  const columns = taxColumns(invoice);
  const { supplier, buyer } = document;
  const taxInvoice = invoice.documentType === 'tax_invoice';

  return {
    kind: invoice.documentType,
    title: taxInvoice ? labels.taxInvoice : labels.billOfSupply,
    compositionNotice: taxInvoice ? null : LEGAL_TEXTS.compositionNotice,
    copyMark: document.copy === null ? null : LEGAL_TEXTS.copyMarks[document.copy],
    secondLanguage: document.secondLanguage,
    labels,
    business: { name: supplier.tradeName ?? supplier.legalName, logoUrl: document.logoUrl },
    supplier: {
      name: supplier.legalName,
      legalName: supplier.legalName,
      gstin: supplier.gstin,
      addressLines: addressLines(supplier.address),
      state: stateLabel(supplier.address.stateCode),
      phone: supplier.phone,
      email: supplier.email,
    },
    buyer: {
      name: buyer.name ?? labels.walkInCustomer.text,
      gstin: buyer.gstin,
      registered: buyer.gstin !== null,
      addressLines: buyer.address === null ? [] : addressLines(buyer.address),
      state: buyer.address === null ? null : stateLabel(buyer.address.stateCode),
      phone: buyer.phone,
    },
    shipTo:
      document.shipTo === null
        ? null
        : {
            addressLines: addressLines(document.shipTo),
            state: stateLabel(document.shipTo.stateCode),
          },
    number: document.number,
    date: formatPrintDate(document.issuedOn),
    placeOfSupply: stateLabel(invoice.placeOfSupply),
    supplyType: invoice.supplyType,
    buyerType: invoice.buyerType,
    gstClass: gstClassOf(invoice),
    reverseCharge: taxInvoice ? (document.reverseCharge ? LEGAL_TEXTS.yes : LEGAL_TEXTS.no) : null,
    pricesIncludeTax: invoice.pricesIncludeTax,
    taxColumns: columns,
    lines: invoice.lines.map((line, index) => {
      const detail = at(document.lines, index);
      const discountPaise = line.lineDiscountPaise + line.invoiceDiscountPaise;
      return {
        serial: index + 1,
        description: detail.description,
        variant: detail.variant,
        hsn: detail.hsnCode,
        quantity: formatQuantity(line.quantityMilli),
        uqc: detail.uqc,
        price: formatAmount(line.unitPricePaise),
        discount: discountPaise > 0 ? formatAmount(discountPaise) : null,
        taxable: formatAmount(line.taxablePaise),
        rate: line.rate === null ? null : formatRate(line.rate.nature, line.rate.rateBasisPoints),
        taxes: Object.fromEntries(
          columns.map(({ key }) => [key, formatAmount(line[HEAD_PAISE[key]])]),
        ),
        amount: formatAmount(line.totalPaise),
      };
    }),
    taxSummary: invoice.taxSummary.map((row) => ({
      rate: formatRate(row.nature, row.rateBasisPoints),
      taxable: formatAmount(row.taxablePaise),
      taxes: Object.fromEntries(
        columns.map(({ key }) => [key, formatAmount(row[HEAD_PAISE[key]])]),
      ),
      totalTax: formatAmount(row.taxPaise),
    })),
    totals: totalRows(invoice, labels, columns),
    grandTotal: formatINR(invoice.totals.payablePaise),
    amountInWords: invoice.amountInWords,
    notes: document.notes,
    terms: document.terms,
    bank: document.bank,
    signatory: {
      forLine: fillLabel(LEGAL_TEXTS.forSupplier, { name: supplier.legalName }),
      name: document.signatoryName,
    },
    requirements,
    issues: printIssues(document, requirements),
  };
}
