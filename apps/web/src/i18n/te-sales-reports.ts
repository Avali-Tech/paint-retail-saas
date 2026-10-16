// Telugu messages for the sales reports, the GST summary and the sales tile (draft: see
// docs/translations/glossary.md). Same keys as en-sales-reports.ts.
import type {
  salesReportColumnsEn,
  salesReportEnumsEn,
  salesReportFiltersEn,
  salesReportKindsEn,
  salesReportsEn,
} from './en-sales-reports.js';
import type { Translation } from './shape.js';

export const salesReportKindsTe: Translation<typeof salesReportKindsEn> = {
  'sales-by-period': {
    title: 'రోజు వారీ అమ్మకాలు',
    description:
      'రోజు, వారం లేదా నెల వారీ నికర అమ్మకాలు: బిల్లులు, క్రెడిట్ నోట్లు, GST, సగటు బిల్లు',
  },
  'sales-by-store': {
    title: 'స్టోర్ వారీ అమ్మకాలు',
    description: 'ప్రతి స్టోర్ నికర అమ్మకాలు, మొత్తంలో దాని వాటాతో',
  },
  'sales-by-product': {
    title: 'ప్రోడక్ట్ వారీ అమ్మకాలు',
    description: 'ప్రతి ప్యాక్ నికర యూనిట్లు, లీటర్లు, అమ్మకం విలువ',
  },
  'sales-by-brand': {
    title: 'బ్రాండ్ వారీ అమ్మకాలు',
    description: 'ప్రతి బ్రాండ్ నికర యూనిట్లు, లీటర్లు, అమ్మకం విలువ',
  },
  'sales-by-category': {
    title: 'కేటగిరీ వారీ అమ్మకాలు',
    description: 'ప్రతి ప్రోడక్ట్ కేటగిరీ నికర యూనిట్లు, లీటర్లు, అమ్మకం విలువ',
  },
  'sales-by-salesperson': {
    title: 'సేల్స్‌పర్సన్ వారీ అమ్మకాలు',
    description: 'ప్రతి వ్యక్తి ఇచ్చిన బిల్లుల నికర అమ్మకాలు',
  },
  'sales-by-customer': {
    title: 'కస్టమర్ వారీ అమ్మకాలు',
    description: 'నికర అమ్మకాల ప్రకారం మీ పెద్ద కస్టమర్లు, వారి చివరి బిల్లుతో',
  },
  'payments-by-mode': {
    title: 'పేమెంట్ మోడ్ వారీ వసూళ్లు',
    description:
      'ప్రతి రోజు స్టోర్, మోడ్ వారీగా వచ్చిన, తిరిగి ఇచ్చిన డబ్బు, డే ఎండ్ లెక్కించినట్లే',
  },
  'gst-summary': {
    title: 'GST సారాంశం',
    description:
      'GSTIN, రేటు వారీగా పన్ను విధించదగిన విలువ, పన్ను, B2B, B2C, క్రెడిట్ నోట్లు తీసివేసి. ఇది GSTR-1 ఫైలింగ్ కాదు',
  },
  'gst-hsn-summary': {
    title: 'HSN వారీ GST సారాంశం',
    description: 'ప్రతి HSN కోడ్, రేటుకు పరిమాణం, పన్ను విధించదగిన విలువ, పన్ను',
  },
};

const sales = {
  bills: 'బిల్లులు',
  creditNotes: 'క్రెడిట్ నోట్లు',
  taxable: 'నికర అమ్మకాలు (₹, GST ముందు)',
  tax: 'GST (₹)',
  value: 'GST తో నికర అమ్మకాలు (₹)',
  averageBill: 'సగటు బిల్లు (₹, GST ముందు)',
};
const quantities = { quantity: 'పరిమాణం (నికర)', litres: 'లీటర్లు (నికర)' };
const share = 'నికర అమ్మకాల్లో వాటా (%)';
const gstHeads = {
  taxable: 'పన్ను విధించదగిన విలువ (₹)',
  cgst: 'CGST (₹)',
  sgst: 'SGST / UTGST (₹)',
  igst: 'IGST (₹)',
  cess: 'సెస్ (₹)',
  tax: 'మొత్తం పన్ను (₹)',
};

export const salesReportColumnsTe: Translation<typeof salesReportColumnsEn> = {
  'sales-by-period': { period: 'రోజు, వారం (సోమవారం నుంచి) లేదా నెల', ...sales },
  'sales-by-store': { store: 'స్టోర్', name: 'పేరు', gstin: 'GSTIN', ...sales, share },
  'sales-by-product': {
    sku: 'SKU',
    brand: 'బ్రాండ్',
    product: 'ప్రోడక్ట్',
    variant: 'సైజ్ / ప్యాక్',
    category: 'కేటగిరీ',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-brand': {
    brand: 'బ్రాండ్',
    products: 'అమ్మిన ప్యాక్‌లు',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-category': {
    category: 'కేటగిరీ',
    products: 'అమ్మిన ప్యాక్‌లు',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-salesperson': {
    salesperson: 'సేల్స్‌పర్సన్ (బిల్లు ఇచ్చినవారు)',
    customers: 'కస్టమర్లు',
    ...sales,
    share,
  },
  'sales-by-customer': {
    customer: 'కస్టమర్',
    phone: 'మొబైల్',
    customerType: 'కస్టమర్ రకం',
    gstin: 'GSTIN',
    lastBilled: 'చివరి బిల్లు',
    ...sales,
    share,
  },
  'payments-by-mode': {
    day: 'తేదీ',
    store: 'స్టోర్',
    mode: 'పేమెంట్ మోడ్',
    modeKind: 'రకం',
    payments: 'పేమెంట్లు',
    received: 'వచ్చినది (₹)',
    atCounter: 'అందులో కౌంటర్ వద్ద (₹)',
    refunded: 'తిరిగి ఇచ్చినది (₹)',
    net: 'నికరం (₹)',
    bounced: 'తర్వాత బౌన్స్ అయిన చెక్కులు (₹)',
  },
  'gst-summary': {
    gstin: 'మా GSTIN',
    stores: 'స్టోర్లు',
    section: 'సరఫరా',
    rate: 'GST రేటు (%)',
    cessRate: 'సెస్ రేటు (%)',
    buyerType: 'B2B / B2C',
    supplyType: 'రాష్ట్రం లోపల / బయట',
    documents: 'డాక్యుమెంట్లు',
    creditNotes: 'అందులో క్రెడిట్ నోట్లు',
    ...gstHeads,
  },
  'gst-hsn-summary': {
    gstin: 'మా GSTIN',
    hsn: 'HSN',
    uqc: 'యూనిట్ (UQC)',
    section: 'సరఫరా',
    rate: 'GST రేటు (%)',
    quantity: 'పరిమాణం (నికర)',
    ...gstHeads,
    value: 'మొత్తం విలువ (₹)',
  },
};

export const salesReportFiltersTe: Translation<typeof salesReportFiltersEn> = {
  interval: 'దేని ప్రకారం',
  kind: 'డాక్యుమెంట్',
  buyerType: 'B2B / B2C',
  customerType: 'కస్టమర్ రకం',
  salespersonId: 'సేల్స్‌పర్సన్ (బిల్లు ఇచ్చినవారు)',
  customerSalespersonId: 'కస్టమర్ సేల్స్‌పర్సన్',
  brandId: 'బ్రాండ్',
  categoryId: 'కేటగిరీ',
  product: 'ప్రోడక్ట్ లేదా SKU',
  modeKind: 'పేమెంట్ మోడ్',
};

export const salesReportsTe: Translation<typeof salesReportsEn> = {
  reportSections: {
    sales: 'అమ్మకాలు, GST',
    other: 'స్టాక్, కొనుగోళ్లు, కస్టమర్లు, బ్రాండ్లు',
  },
  salesTile: {
    title: 'నికర అమ్మకాలు (GST ముందు)',
    error: 'అమ్మకాలు లోడ్ కాలేదు',
    period: { today: 'ఈ రోజు', week: 'ఈ వారం', month: 'ఈ నెల' },
    previous: { today: 'నిన్న', week: 'గత వారం', month: 'గత నెల' },
    up: '{previous} కంటే {percent}% ఎక్కువ',
    down: '{previous} కంటే {percent}% తక్కువ',
    noComparison: '{previous} అమ్మకాలు లేవు, పోలిక లేదు',
    withGst: 'GST తో {amount}',
    bills: '{count} బిల్లులు',
    average: 'సగటు {amount}',
    trend: 'గత 14 రోజులు',
    day: 'రోజు',
    netSales: 'నికర అమ్మకాలు (GST ముందు)',
    note: 'ఇన్వాయిస్‌లు, బిల్ ఆఫ్ సప్లై, డెబిట్ నోట్ల నుంచి క్రెడిట్ నోట్లు తీసివేసి; రద్దయిన బిల్లులు లెక్కలో లేవు.',
    open: 'అమ్మకాల రిపోర్టులు తెరవండి',
  },
};

export const salesReportEnumsTe: Translation<typeof salesReportEnumsEn> = {
  salesIntervals: { day: 'రోజు', week: 'వారం', month: 'నెల' },
  buyerTypes: { b2b: 'B2B (కొనుగోలుదారుకు GSTIN ఉంది)', b2c: 'B2C' },
  gstSections: {
    taxable: 'పన్ను విధించదగినది',
    nil_rated: 'నిల్ రేటెడ్',
    exempt: 'మినహాయింపు',
    non_gst: 'GST పరిధి బయట',
    bill_of_supply: 'బిల్ ఆఫ్ సప్లై (కంపోజిషన్)',
  },
};
