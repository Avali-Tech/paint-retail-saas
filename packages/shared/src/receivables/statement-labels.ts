import type { PartyLedgerEntryKind } from '../billing-api.js';
import {
  INVOICE_LABELS,
  type InvoiceLabelKey,
  type PrintLabel,
  type PrintLanguage,
  type SecondLanguage,
} from '../invoice-print/labels.js';
import type { AgeingBucket } from './ageing.js';

/**
 * Printed statement labels (roadmap P2-M12) in English, Hindi and Telugu: English
 * always, the chosen second language under it, as on the invoice and the quotation.
 * Labels shared with the invoice come from its catalogue. The Hindi and Telugu texts
 * are drafts in the style of docs/translations/glossary.md (बकाया / బకాయి for money
 * owed), with no Latin letters, so the PDF draws each with one script font: dates
 * are printed beside a label, never inside a translation.
 */

const SHARED_KEYS = [
  'date',
  'gstin',
  'phone',
  'page',
  'continued',
] as const satisfies readonly InvoiceLabelKey[];

const ENTRY_KEYS = [
  'entry_opening',
  'entry_invoice',
  'entry_debit_note',
  'entry_credit_note',
  'entry_payment_in',
  'entry_refund_out',
  'entry_cheque_bounce',
  'entry_adjustment',
  'entry_cancellation',
] as const satisfies readonly `entry_${PartyLedgerEntryKind}`[];

const BUCKET_KEYS = [
  'bucket_not_due',
  'bucket_days_0_30',
  'bucket_days_31_60',
  'bucket_days_61_90',
  'bucket_days_90_plus',
] as const satisfies readonly `bucket_${AgeingBucket}`[];

const STATEMENT_ONLY_KEYS = [
  'statement',
  'period',
  'customer',
  'particulars',
  'reference',
  'debit',
  'credit',
  'balance',
  'openingBalance',
  'closingBalance',
  'total',
  'ageing',
  'outstanding',
  'advance',
  'netBalance',
  'openItems',
  'dueOn',
  'daysPastDue',
  'amountDue',
  'noEntries',
  'computerGenerated',
  ...ENTRY_KEYS,
  ...BUCKET_KEYS,
] as const;

export const STATEMENT_LABEL_KEYS = [...SHARED_KEYS, ...STATEMENT_ONLY_KEYS] as const;
export type StatementLabelKey = (typeof STATEMENT_LABEL_KEYS)[number];
type StatementOnlyKey = (typeof STATEMENT_ONLY_KEYS)[number];

export const STATEMENT_LABELS: Readonly<
  Record<PrintLanguage, Readonly<Record<StatementOnlyKey, string>>>
> = {
  en: {
    statement: 'Statement of Account',
    period: 'Period',
    customer: 'Customer',
    particulars: 'Particulars',
    reference: 'Document no.',
    debit: 'Debit',
    credit: 'Credit',
    balance: 'Balance',
    openingBalance: 'Opening balance',
    closingBalance: 'Closing balance',
    total: 'Total',
    ageing: 'Ageing',
    outstanding: 'Total outstanding',
    advance: 'Paid in advance',
    netBalance: 'Balance due',
    openItems: 'Bills due',
    dueOn: 'Due on',
    daysPastDue: 'Days late',
    amountDue: 'Amount due',
    noEntries: 'No entries in this period',
    computerGenerated: 'This is a computer-generated statement.',
    entry_opening: 'Opening balance',
    entry_invoice: 'Invoice',
    entry_debit_note: 'Debit note',
    entry_credit_note: 'Credit note',
    entry_payment_in: 'Payment received',
    entry_refund_out: 'Refund paid',
    entry_cheque_bounce: 'Cheque bounced',
    entry_adjustment: 'Charge',
    entry_cancellation: 'Invoice cancelled',
    bucket_not_due: 'Not yet due',
    bucket_days_0_30: '0–30 days',
    bucket_days_31_60: '31–60 days',
    bucket_days_61_90: '61–90 days',
    bucket_days_90_plus: 'Over 90 days',
  },
  hi: {
    statement: 'खाता विवरण',
    period: 'अवधि',
    customer: 'ग्राहक',
    particulars: 'विवरण',
    reference: 'दस्तावेज़ नंबर',
    debit: 'नामे',
    credit: 'जमा',
    balance: 'बैलेंस',
    openingBalance: 'शुरुआती बैलेंस',
    closingBalance: 'अंतिम बैलेंस',
    total: 'कुल',
    ageing: 'बकाया की उम्र',
    outstanding: 'कुल बकाया',
    advance: 'अग्रिम जमा',
    netBalance: 'देय बकाया',
    openItems: 'बकाया बिल',
    dueOn: 'देय तारीख',
    daysPastDue: 'देरी के दिन',
    amountDue: 'बकाया राशि',
    noEntries: 'इस अवधि में कोई एंट्री नहीं',
    computerGenerated: 'यह कंप्यूटर से बना विवरण है।',
    entry_opening: 'शुरुआती बैलेंस',
    entry_invoice: 'इनवॉइस',
    entry_debit_note: 'डेबिट नोट',
    entry_credit_note: 'क्रेडिट नोट',
    entry_payment_in: 'भुगतान मिला',
    entry_refund_out: 'रिफंड दिया',
    entry_cheque_bounce: 'चेक बाउंस',
    entry_adjustment: 'शुल्क',
    entry_cancellation: 'इनवॉइस रद्द',
    bucket_not_due: 'अभी देय नहीं',
    bucket_days_0_30: '0-30 दिन',
    bucket_days_31_60: '31-60 दिन',
    bucket_days_61_90: '61-90 दिन',
    bucket_days_90_plus: '90 दिन से ज़्यादा',
  },
  te: {
    statement: 'ఖాతా వివరణ',
    period: 'కాలం',
    customer: 'కస్టమర్',
    particulars: 'వివరాలు',
    reference: 'డాక్యుమెంట్ నంబర్',
    debit: 'డెబిట్',
    credit: 'జమ',
    balance: 'బ్యాలెన్స్',
    openingBalance: 'ప్రారంభ బ్యాలెన్స్',
    closingBalance: 'ముగింపు బ్యాలెన్స్',
    total: 'మొత్తం',
    ageing: 'బకాయి వయస్సు',
    outstanding: 'మొత్తం బకాయి',
    advance: 'ముందస్తు చెల్లింపు',
    netBalance: 'చెల్లించాల్సిన బకాయి',
    openItems: 'బకాయి బిల్లులు',
    dueOn: 'గడువు తేదీ',
    daysPastDue: 'ఆలస్యమైన రోజులు',
    amountDue: 'బకాయి మొత్తం',
    noEntries: 'ఈ కాలంలో పద్దులు లేవు',
    computerGenerated: 'ఇది కంప్యూటర్ ద్వారా తయారైన వివరణ.',
    entry_opening: 'ప్రారంభ బ్యాలెన్స్',
    entry_invoice: 'ఇన్‌వాయిస్',
    entry_debit_note: 'డెబిట్ నోట్',
    entry_credit_note: 'జమ నోట్',
    entry_payment_in: 'చెల్లింపు అందింది',
    entry_refund_out: 'రిఫండ్ ఇచ్చాం',
    entry_cheque_bounce: 'చెక్ బౌన్స్',
    entry_adjustment: 'ఛార్జ్',
    entry_cancellation: 'ఇన్‌వాయిస్ రద్దు',
    bucket_not_due: 'ఇంకా గడువు రాలేదు',
    bucket_days_0_30: '0-30 రోజులు',
    bucket_days_31_60: '31-60 రోజులు',
    bucket_days_61_90: '61-90 రోజులు',
    bucket_days_90_plus: '90 రోజులకు పైగా',
  },
};

export type StatementLabels = Readonly<Record<StatementLabelKey, PrintLabel>>;

function text(language: PrintLanguage, key: StatementLabelKey): string {
  return (SHARED_KEYS as readonly string[]).includes(key)
    ? INVOICE_LABELS[language][key as InvoiceLabelKey]
    : STATEMENT_LABELS[language][key as StatementOnlyKey];
}

/** Every statement label in English, each with its translation in `second` (or none). */
export function statementLabels(second: SecondLanguage | null): StatementLabels {
  return Object.fromEntries(
    STATEMENT_LABEL_KEYS.map((key) => {
      const english = text('en', key);
      const other = second === null ? english : text(second, key);
      return [key, { text: english, translation: other === english ? null : other }];
    }),
  ) as StatementLabels;
}
