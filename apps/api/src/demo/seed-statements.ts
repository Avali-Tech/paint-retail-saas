import {
  paiseToRupees,
  toCsv,
  type BrandStatementDetail,
  type SchemeDetail,
  type SchemeSummary,
  type StatementTemplateView,
} from '@paint/shared';
import { indiaDate } from './history-clock.js';
import { DEMO_BUSINESS } from './plan.js';
import { must, type SeedContext } from './seed-context.js';

/** What the seed reads of a GRN. */
interface Receipt {
  readonly id: string;
  readonly supplierInvoiceNumber: string | null;
  readonly supplierInvoiceDate: string | null;
  readonly receivedAt: string;
  readonly lines: readonly {
    readonly variantId: string;
    readonly quantity: number;
    readonly unitCostPaise: number | null;
  }[];
}

/** The deliberate mismatches of the demo statement, for the seed's test. */
export const STATEMENT_DEMO = {
  /** A distributor invoice we never received goods for. */
  missingInvoice: 'MISSING',
  /** Billed ₹250 above our GRN (a rate difference). */
  rateDifferencePaise: 250_00,
  /** A scheme credit note the brand issued that we have not recorded. */
  unrecordedCreditNote: 'CN/26/90117',
  unrecordedCreditNotePaise: 2_150_00,
  /** Our payment to the distributor (payables come with P2-M17). */
  payment: 'NEFT/UTIB0000123',
} as const;

const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const rupees = (paise: number) => paiseToRupees(paise);

/**
 * The first distributor's statement of account for the last month (P2-M34, spec §7 round 6:
 * "a month's brand statement reconciles with mismatches listed"). Run after the schemes,
 * so the credit note the booster recorded is on it. The distributor bills every GRN of the
 * month with GST, one of them ₹250 more than we booked; it also bills an invoice whose
 * goods never came, shows the booster's credit note we recorded and another we did not,
 * and our payment. The statement is laid out as a portal's Excel export saved as CSV: a
 * title, the business, then the columns, and a closing total.
 */
export async function seedStatements(context: SeedContext): Promise<void> {
  const { plan } = context;
  const owner = context.as('owner');
  const supplierPlan = must(
    plan.parties.find((party) => party.segment === 'supplier'),
    'supplier',
  );
  const supplier = context.party(supplierPlan.key);
  const brandId = must(context.brandIds.get(String(supplierPlan.brand)), 'brand');

  const template = await owner.post<StatementTemplateView>('/brand-statements/templates', {
    name: `${supplier.displayName} ledger`,
    supplierPartyId: supplier.id,
    brandId,
    headerRowsToSkip: 2,
    dateColumn: 'Date',
    documentColumn: 'Doc No',
    typeColumn: 'Voucher Type',
    referenceColumn: 'Ref No',
    descriptionColumn: 'Particulars',
    amountMode: 'debit_credit',
    debitColumn: 'Debit',
    creditColumn: 'Credit',
    dateFormat: 'dd-mm-yyyy',
    typeRules: {
      opening: ['Opening Balance'],
      invoice: ['Sales Invoice'],
      credit_note: ['Credit Note'],
      payment: ['Receipt'],
    },
    dateWindowDays: 5,
    amountTolerancePaise: 100,
    grnAmountBasis: 'with_gst',
  });
  context.count('statement templates');

  const periodTo = indiaDate(1);
  const periodFrom = indiaDate(Math.min(30, plan.historyDays - 1));
  const inPeriod = (day: string) => day >= periodFrom && day <= periodTo;

  // GST as the API counts it: each line's taxable value at its category's rate. Every
  // demo GRN has a supplier invoice number and date, and a cost on each line.
  const categories =
    await owner.get<{ id: string; currentRateBps: number | null }[]>('/tax-categories');
  const rates = new Map(categories.map((category) => [category.id, category.currentRateBps]));
  const rateOf = (variantId: string) => {
    const variant = must(
      context.variants.find((one) => one.id === variantId),
      'variant',
    );
    return Number(rates.get(context.taxCategoryId(variant.product.taxCategory)));
  };
  const page = await owner.get<{ items: { id: string }[] }>(
    `/goods-receipts?supplierId=${supplier.id}&limit=200`,
  );
  const grns = await Promise.all(
    page.items.map(({ id }) => owner.get<Receipt>(`/goods-receipts/${id}`)),
  );
  const receipts = grns
    .map((grn) => ({
      day: String(grn.supplierInvoiceDate),
      number: String(grn.supplierInvoiceNumber),
      amountPaise: grn.lines.reduce((sum, line) => {
        const value = Math.round(line.quantity * Number(line.unitCostPaise));
        return sum + value + Math.round((value * rateOf(line.variantId)) / 10_000);
      }, 0),
    }))
    .filter((receipt) => inPeriod(receipt.day))
    .sort((a, b) => `${a.day} ${a.number}`.localeCompare(`${b.day} ${b.number}`));

  // The booster's credit notes the owner recorded in the month.
  const schemes = await owner.get<SchemeSummary[]>(`/brand-schemes?brandId=${brandId}`);
  const details = await Promise.all(
    schemes.map(({ scheme }) => owner.get<SchemeDetail>(`/brand-schemes/${scheme.id}`)),
  );
  const credits = details
    .flatMap((detail) => detail.receipts)
    .filter((receipt) => receipt.kind === 'money' && inPeriod(receipt.receivedOn))
    .map((receipt) => ({
      day: receipt.receivedOn,
      reference: String(receipt.reference),
      amountPaise: Number(receipt.amountPaise),
    }));

  interface Row {
    readonly day: string;
    readonly doc: string;
    readonly type: string;
    readonly ref: string;
    readonly text: string;
    readonly paise: number;
  }
  const rows: Row[] = [];
  receipts.forEach((receipt, index) => {
    const last = index === receipts.length - 1 && receipts.length > 1;
    rows.push({
      day: receipt.day,
      doc: receipt.number,
      type: 'Sales Invoice',
      ref: '',
      text: last ? 'Goods as per invoice (revised rate)' : 'Goods as per invoice',
      paise: receipt.amountPaise + (last ? STATEMENT_DEMO.rateDifferencePaise : 0),
    });
  });
  const middle = indiaDate(Math.round(Math.min(30, plan.historyDays - 1) / 2));
  const prefix = supplierPlan.key.toUpperCase().replace('SUPPLIER-', 'INV');
  rows.push({
    day: middle,
    doc: `${prefix}/26-27/${STATEMENT_DEMO.missingInvoice}`,
    type: 'Sales Invoice',
    ref: '',
    text: 'Goods as per invoice',
    paise: 18_450_00,
  });
  for (const credit of credits) {
    rows.push({
      day: credit.day,
      doc: credit.reference,
      type: 'Credit Note',
      ref: '',
      text: 'Scheme credit note: pre-monsoon booster',
      paise: -credit.amountPaise,
    });
  }
  rows.push({
    day: indiaDate(3),
    doc: STATEMENT_DEMO.unrecordedCreditNote,
    type: 'Credit Note',
    ref: 'CIRC/Q2/2026',
    text: 'Scheme credit note: monsoon quarter, slab 1',
    paise: -STATEMENT_DEMO.unrecordedCreditNotePaise,
  });
  const billed = rows.filter((row) => row.paise > 0).reduce((sum, row) => sum + row.paise, 0);
  rows.push({
    day: indiaDate(2),
    doc: STATEMENT_DEMO.payment,
    type: 'Receipt',
    ref: 'UTR 4521 8890 1123',
    text: 'Received with thanks',
    paise: -Math.round(billed / 2 / 100) * 100,
  });
  rows.sort((a, b) => a.day.localeCompare(b.day));

  const opening = 1_25_000_00;
  const total = rows.reduce((sum, row) => sum + row.paise, opening);
  const csv = toCsv([
    [`${supplier.displayName}: statement of account`],
    [`${DEMO_BUSINESS}, ${dmy(periodFrom)} to ${dmy(periodTo)}`],
    ['Date', 'Doc No', 'Voucher Type', 'Ref No', 'Particulars', 'Debit', 'Credit'],
    [dmy(periodFrom), '', 'Opening Balance', '', 'Brought forward', rupees(opening), ''],
    ...rows.map((row) => [
      dmy(row.day),
      row.doc,
      row.type,
      row.ref,
      row.text,
      row.paise > 0 ? rupees(row.paise) : '',
      row.paise < 0 ? rupees(-row.paise) : '',
    ]),
    ['', '', 'Closing Balance', '', '', rupees(total), ''],
  ]);
  await owner.upload<BrandStatementDetail>(
    '/brand-statements',
    {
      templateId: template.id,
      periodFrom,
      periodTo,
      closingBalancePaise: String(total),
    },
    {
      fileName: `${supplierPlan.key}-statement.csv`,
      data: Buffer.from(csv),
      contentType: 'text/csv',
    },
  );
  context.count('brand statements');
}
