import {
  INVOICE_LABELS,
  type InvoiceLabelKey,
  type PrintLabel,
  type PrintLanguage,
  type SecondLanguage,
} from './labels.js';

/**
 * Printed quotation labels (the API's quotation PDF) in English, Hindi and Telugu,
 * English always printed with the chosen second language under it, as on the invoice.
 * A quotation is an offer, never a tax invoice: it is headed "Quotation" and says so.
 * The labels it shares with the invoice come from the invoice's catalogue; the Hindi
 * and Telugu texts are drafts (docs/translations/glossary.md).
 */

const SHARED_KEYS = [
  'date',
  'billTo',
  'gstin',
  'phone',
  'placeOfSupply',
  'serialNumber',
  'description',
  'hsn',
  'quantity',
  'price',
  'priceInclusive',
  'discount',
  'taxableValue',
  'gstRate',
  'amount',
  'roundOff',
  'grandTotal',
  'amountInWords',
  'notes',
  'tint',
  'page',
  'continued',
] as const satisfies readonly InvoiceLabelKey[];

export const QUOTATION_ONLY_KEYS = [
  'quotation',
  'quotationNumber',
  'version',
  'validUntil',
  'site',
  'influencer',
  'tax',
  'notInvoice',
] as const;

export const QUOTATION_LABEL_KEYS = [...SHARED_KEYS, ...QUOTATION_ONLY_KEYS] as const;
export type QuotationLabelKey = (typeof QUOTATION_LABEL_KEYS)[number];
type QuotationOnlyKey = (typeof QUOTATION_ONLY_KEYS)[number];

export const QUOTATION_ONLY_LABELS: Readonly<
  Record<PrintLanguage, Readonly<Record<QuotationOnlyKey, string>>>
> = {
  en: {
    quotation: 'Quotation',
    quotationNumber: 'Quotation no.',
    version: 'Version',
    validUntil: 'Valid until',
    site: 'Site',
    influencer: 'Influencer',
    tax: 'Tax',
    notInvoice: 'This is a quotation, not a tax invoice.',
  },
  hi: {
    quotation: 'कोटेशन',
    quotationNumber: 'कोटेशन नंबर',
    version: 'वर्जन',
    validUntil: 'इस तारीख तक मान्य',
    site: 'साइट',
    influencer: 'इन्फ्लुएंसर',
    tax: 'टैक्स',
    notInvoice: 'यह कोटेशन है, टैक्स इनवॉइस नहीं।',
  },
  te: {
    quotation: 'కొటేషన్',
    quotationNumber: 'కొటేషన్ నంబర్',
    version: 'వెర్షన్',
    validUntil: 'ఈ తేదీ వరకు చెల్లుతుంది',
    site: 'సైట్',
    influencer: 'ఇన్‌ఫ్లుయెన్సర్',
    tax: 'ట్యాక్స్',
    notInvoice: 'ఇది కొటేషన్ మాత్రమే, ట్యాక్స్ ఇన్‌వాయిస్ కాదు.',
  },
};

export type QuotationLabels = Readonly<Record<QuotationLabelKey, PrintLabel>>;

function text(language: PrintLanguage, key: QuotationLabelKey): string {
  return (SHARED_KEYS as readonly string[]).includes(key)
    ? INVOICE_LABELS[language][key as InvoiceLabelKey]
    : QUOTATION_ONLY_LABELS[language][key as QuotationOnlyKey];
}

/** Every quotation label in English, each with its translation in `second` (or none). */
export function quotationLabels(second: SecondLanguage | null): QuotationLabels {
  return Object.fromEntries(
    QUOTATION_LABEL_KEYS.map((key) => {
      const english = text('en', key);
      const other = second === null ? english : text(second, key);
      return [key, { text: english, translation: other === english ? null : other }];
    }),
  ) as QuotationLabels;
}
