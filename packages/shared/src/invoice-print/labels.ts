/**
 * Printed invoice labels in English, Hindi and Telugu. English is always printed;
 * Hindi or Telugu can be added as a second line under each label. Legal headings
 * ("Tax Invoice", "Bill of Supply", the composition notice, copy marks) stay in
 * English whatever the second language ([CA-12]).
 *
 * The Hindi and Telugu texts are drafts in the style of docs/translations/glossary.md:
 * trade words in the local script, abbreviations (GST, GSTIN, HSN, CGST…) in Latin.
 * They live here, not in the web app's catalogue, because the API prints them too.
 */

export type PrintLanguage = 'en' | 'hi' | 'te';
/** A language printed under the English labels. */
export type SecondLanguage = Exclude<PrintLanguage, 'en'>;

export const INVOICE_LABEL_KEYS = [
  'taxInvoice',
  'billOfSupply',
  'invoiceNumber',
  'billNumber',
  'date',
  'supplier',
  'billTo',
  'shipTo',
  'gstin',
  'unregistered',
  'walkInCustomer',
  'state',
  'phone',
  'placeOfSupply',
  'reverseCharge',
  'serialNumber',
  'description',
  'hsn',
  'quantity',
  'unit',
  'price',
  'priceInclusive',
  'discount',
  'taxableValue',
  'value',
  'gstRate',
  'amount',
  'taxSummary',
  'rate',
  'totalTax',
  'subtotal',
  'roundOff',
  'grandTotal',
  'amountInWords',
  'notes',
  'terms',
  'bankDetails',
  'bankAccount',
  'ifsc',
  'upi',
  'authorisedSignatory',
  'page',
  'continued',
] as const;

export type InvoiceLabelKey = (typeof INVOICE_LABEL_KEYS)[number];
export type InvoiceLabelSet = Readonly<Record<InvoiceLabelKey, string>>;

export const INVOICE_LABELS: Readonly<Record<PrintLanguage, InvoiceLabelSet>> = {
  en: {
    taxInvoice: 'Tax Invoice',
    billOfSupply: 'Bill of Supply',
    invoiceNumber: 'Invoice no.',
    billNumber: 'Bill no.',
    date: 'Date',
    supplier: 'Supplier',
    billTo: 'Bill to',
    shipTo: 'Ship to',
    gstin: 'GSTIN',
    unregistered: 'Unregistered',
    walkInCustomer: 'Walk-in customer',
    state: 'State',
    phone: 'Phone',
    placeOfSupply: 'Place of supply',
    reverseCharge: 'Whether tax is payable on reverse charge',
    serialNumber: '#',
    description: 'Description',
    hsn: 'HSN',
    quantity: 'Qty',
    unit: 'Unit',
    price: 'Rate',
    priceInclusive: 'Rate (incl. GST)',
    discount: 'Discount',
    taxableValue: 'Taxable value',
    value: 'Value',
    gstRate: 'GST %',
    amount: 'Amount',
    taxSummary: 'Tax summary',
    rate: 'Rate',
    totalTax: 'Total tax',
    subtotal: 'Subtotal',
    roundOff: 'Round off',
    grandTotal: 'Total',
    amountInWords: 'Amount in words',
    notes: 'Notes',
    terms: 'Terms and conditions',
    bankDetails: 'Bank details',
    bankAccount: 'Account',
    ifsc: 'IFSC',
    upi: 'UPI',
    authorisedSignatory: 'Authorised signatory',
    page: 'Page {page} of {pages}',
    continued: 'Continued',
  },
  hi: {
    taxInvoice: 'टैक्स इनवॉइस',
    billOfSupply: 'बिल ऑफ सप्लाई',
    invoiceNumber: 'इनवॉइस नंबर',
    billNumber: 'बिल नंबर',
    date: 'तारीख',
    supplier: 'विक्रेता',
    billTo: 'बिल पाने वाला',
    shipTo: 'माल भेजने का पता',
    gstin: 'GSTIN',
    unregistered: 'अपंजीकृत',
    walkInCustomer: 'काउंटर ग्राहक',
    state: 'राज्य',
    phone: 'फोन',
    placeOfSupply: 'सप्लाई का स्थान',
    reverseCharge: 'क्या टैक्स रिवर्स चार्ज पर देय है',
    serialNumber: 'क्र.',
    description: 'विवरण',
    hsn: 'HSN',
    quantity: 'मात्रा',
    unit: 'यूनिट',
    price: 'दर',
    priceInclusive: 'दर (टैक्स सहित)',
    discount: 'छूट',
    taxableValue: 'टैक्स योग्य मूल्य',
    value: 'मूल्य',
    gstRate: 'GST %',
    amount: 'रकम',
    taxSummary: 'टैक्स सारांश',
    rate: 'दर',
    totalTax: 'कुल टैक्स',
    subtotal: 'उप-योग',
    roundOff: 'राउंड ऑफ',
    grandTotal: 'कुल',
    amountInWords: 'रकम शब्दों में',
    notes: 'नोट',
    terms: 'नियम और शर्तें',
    bankDetails: 'बैंक विवरण',
    bankAccount: 'खाता',
    ifsc: 'IFSC',
    upi: 'UPI',
    authorisedSignatory: 'अधिकृत हस्ताक्षरकर्ता',
    page: 'पेज {page} / {pages}',
    continued: 'जारी',
  },
  te: {
    taxInvoice: 'ట్యాక్స్ ఇన్‌వాయిస్',
    billOfSupply: 'బిల్ ఆఫ్ సప్లై',
    invoiceNumber: 'ఇన్‌వాయిస్ నంబర్',
    billNumber: 'బిల్ నంబర్',
    date: 'తేదీ',
    supplier: 'అమ్మకందారు',
    billTo: 'బిల్ అందుకునేవారు',
    shipTo: 'సరుకు పంపే చిరునామా',
    gstin: 'GSTIN',
    unregistered: 'రిజిస్టర్ కాలేదు',
    walkInCustomer: 'కౌంటర్ కస్టమర్',
    state: 'రాష్ట్రం',
    phone: 'ఫోన్',
    placeOfSupply: 'సప్లై స్థలం',
    reverseCharge: 'రివర్స్ ఛార్జ్‌పై ట్యాక్స్ చెల్లించాలా',
    serialNumber: 'క్ర.సం.',
    description: 'వివరణ',
    hsn: 'HSN',
    quantity: 'క్వాంటిటీ',
    unit: 'యూనిట్',
    price: 'ధర',
    priceInclusive: 'ధర (ట్యాక్స్‌తో)',
    discount: 'డిస్కౌంట్',
    taxableValue: 'ట్యాక్స్ విధించే విలువ',
    value: 'విలువ',
    gstRate: 'GST %',
    amount: 'మొత్తం',
    taxSummary: 'ట్యాక్స్ సారాంశం',
    rate: 'రేటు',
    totalTax: 'మొత్తం ట్యాక్స్',
    subtotal: 'ఉప మొత్తం',
    roundOff: 'రౌండ్ ఆఫ్',
    grandTotal: 'మొత్తం',
    amountInWords: 'మొత్తం అక్షరాల్లో',
    notes: 'నోట్',
    terms: 'నిబంధనలు, షరతులు',
    bankDetails: 'బ్యాంక్ వివరాలు',
    bankAccount: 'ఖాతా',
    ifsc: 'IFSC',
    upi: 'UPI',
    authorisedSignatory: 'అధీకృత సంతకందారు',
    page: 'పేజీ {page} / {pages}',
    continued: 'కొనసాగింపు',
  },
};

/** Fixed English texts the law prescribes; never translated. */
export const LEGAL_TEXTS = {
  /** Rule 5(1)(f): at the top of a composition dealer's bill of supply. */
  compositionNotice: 'Composition taxable person, not eligible to collect tax on supplies',
  /** Rule 48(1): the three copies of a goods invoice. */
  copyMarks: {
    original: 'ORIGINAL FOR RECIPIENT',
    duplicate: 'DUPLICATE FOR TRANSPORTER',
    triplicate: 'TRIPLICATE FOR SUPPLIER',
  },
  yes: 'Yes',
  no: 'No',
  forSupplier: 'For {name}',
} as const;

/** A printed label: the English text, and the second language's under it when chosen. */
export interface PrintLabel {
  readonly text: string;
  /** The second language's text; null when none is chosen or it reads the same (GSTIN, HSN). */
  readonly translation: string | null;
}

export type InvoiceLabels = Readonly<Record<InvoiceLabelKey, PrintLabel>>;

/** Every label in English, each with its translation in `second` (or none). */
export function invoiceLabels(second: SecondLanguage | null): InvoiceLabels {
  const english = INVOICE_LABELS.en;
  const other = second === null ? english : INVOICE_LABELS[second];
  return Object.fromEntries(
    INVOICE_LABEL_KEYS.map((key) => [
      key,
      { text: english[key], translation: other[key] === english[key] ? null : other[key] },
    ]),
  ) as InvoiceLabels;
}

/** Fills "{name}" placeholders. */
export function fillLabel(text: string, params: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}
