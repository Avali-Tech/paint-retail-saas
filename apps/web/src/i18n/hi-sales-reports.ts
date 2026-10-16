// Hindi messages for the sales reports, the GST summary and the sales tile (draft: see
// docs/translations/glossary.md). Same keys as en-sales-reports.ts.
import type {
  salesReportColumnsEn,
  salesReportEnumsEn,
  salesReportFiltersEn,
  salesReportKindsEn,
  salesReportsEn,
} from './en-sales-reports.js';
import type { Translation } from './shape.js';

export const salesReportKindsHi: Translation<typeof salesReportKindsEn> = {
  'sales-by-period': {
    title: 'दिन के हिसाब से बिक्री',
    description: 'दिन, हफ़्ते या महीने की नेट बिक्री: बिल, क्रेडिट नोट, GST और औसत बिल',
  },
  'sales-by-store': {
    title: 'स्टोर के हिसाब से बिक्री',
    description: 'हर स्टोर की नेट बिक्री, कुल में उसके हिस्से के साथ',
  },
  'sales-by-product': {
    title: 'प्रोडक्ट के हिसाब से बिक्री',
    description: 'हर पैक की नेट यूनिट, लीटर और बिक्री मूल्य',
  },
  'sales-by-brand': {
    title: 'ब्रांड के हिसाब से बिक्री',
    description: 'हर ब्रांड की नेट यूनिट, लीटर और बिक्री मूल्य',
  },
  'sales-by-category': {
    title: 'कैटेगरी के हिसाब से बिक्री',
    description: 'हर प्रोडक्ट कैटेगरी की नेट यूनिट, लीटर और बिक्री मूल्य',
  },
  'sales-by-salesperson': {
    title: 'सेल्सपर्सन के हिसाब से बिक्री',
    description: 'हर व्यक्ति के बनाए बिलों की नेट बिक्री',
  },
  'sales-by-customer': {
    title: 'ग्राहक के हिसाब से बिक्री',
    description: 'नेट बिक्री के हिसाब से आपके बड़े ग्राहक, उनके आख़िरी बिल के साथ',
  },
  'payments-by-mode': {
    title: 'पेमेंट मोड के हिसाब से वसूली',
    description: 'हर दिन स्टोर और मोड के हिसाब से मिला और लौटाया पैसा, जैसे डे-एंड गिनता है',
  },
  'gst-summary': {
    title: 'GST सारांश',
    description:
      'GSTIN और रेट के हिसाब से कर योग्य मूल्य और टैक्स, B2B और B2C, क्रेडिट नोट घटाकर। यह GSTR-1 फ़ाइलिंग नहीं है',
  },
  'gst-hsn-summary': {
    title: 'HSN के हिसाब से GST सारांश',
    description: 'हर HSN कोड और रेट की मात्रा, कर योग्य मूल्य और टैक्स',
  },
};

const sales = {
  bills: 'बिल',
  creditNotes: 'क्रेडिट नोट',
  taxable: 'नेट बिक्री (₹, GST से पहले)',
  tax: 'GST (₹)',
  value: 'GST सहित नेट बिक्री (₹)',
  averageBill: 'औसत बिल (₹, GST से पहले)',
};
const quantities = { quantity: 'मात्रा (नेट)', litres: 'लीटर (नेट)' };
const share = 'नेट बिक्री में हिस्सा (%)';
const gstHeads = {
  taxable: 'कर योग्य मूल्य (₹)',
  cgst: 'CGST (₹)',
  sgst: 'SGST / UTGST (₹)',
  igst: 'IGST (₹)',
  cess: 'सेस (₹)',
  tax: 'कुल टैक्स (₹)',
};

export const salesReportColumnsHi: Translation<typeof salesReportColumnsEn> = {
  'sales-by-period': { period: 'दिन, हफ़्ता (सोमवार से) या महीना', ...sales },
  'sales-by-store': { store: 'स्टोर', name: 'नाम', gstin: 'GSTIN', ...sales, share },
  'sales-by-product': {
    sku: 'SKU',
    brand: 'ब्रांड',
    product: 'प्रोडक्ट',
    variant: 'साइज़ / पैक',
    category: 'कैटेगरी',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-brand': {
    brand: 'ब्रांड',
    products: 'बिके पैक',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-category': {
    category: 'कैटेगरी',
    products: 'बिके पैक',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-salesperson': {
    salesperson: 'सेल्सपर्सन (जिसने बिल बनाया)',
    customers: 'ग्राहक',
    ...sales,
    share,
  },
  'sales-by-customer': {
    customer: 'ग्राहक',
    phone: 'मोबाइल',
    customerType: 'ग्राहक का प्रकार',
    gstin: 'GSTIN',
    lastBilled: 'आख़िरी बिल',
    ...sales,
    share,
  },
  'payments-by-mode': {
    day: 'तारीख',
    store: 'स्टोर',
    mode: 'पेमेंट मोड',
    modeKind: 'प्रकार',
    payments: 'पेमेंट',
    received: 'मिला (₹)',
    atCounter: 'इसमें काउंटर पर (₹)',
    refunded: 'लौटाया (₹)',
    net: 'नेट (₹)',
    bounced: 'बाद में बाउंस हुए चेक (₹)',
  },
  'gst-summary': {
    gstin: 'हमारा GSTIN',
    stores: 'स्टोर',
    section: 'सप्लाई',
    rate: 'GST रेट (%)',
    cessRate: 'सेस रेट (%)',
    buyerType: 'B2B / B2C',
    supplyType: 'राज्य के अंदर / बाहर',
    documents: 'दस्तावेज़',
    creditNotes: 'इनमें क्रेडिट नोट',
    ...gstHeads,
  },
  'gst-hsn-summary': {
    gstin: 'हमारा GSTIN',
    hsn: 'HSN',
    uqc: 'यूनिट (UQC)',
    section: 'सप्लाई',
    rate: 'GST रेट (%)',
    quantity: 'मात्रा (नेट)',
    ...gstHeads,
    value: 'कुल मूल्य (₹)',
  },
};

export const salesReportFiltersHi: Translation<typeof salesReportFiltersEn> = {
  interval: 'किस हिसाब से',
  kind: 'दस्तावेज़',
  buyerType: 'B2B / B2C',
  customerType: 'ग्राहक का प्रकार',
  salespersonId: 'सेल्सपर्सन (जिसने बिल बनाया)',
  customerSalespersonId: 'ग्राहक का सेल्सपर्सन',
  brandId: 'ब्रांड',
  categoryId: 'कैटेगरी',
  product: 'प्रोडक्ट या SKU',
  modeKind: 'पेमेंट मोड',
};

export const salesReportsHi: Translation<typeof salesReportsEn> = {
  reportSections: {
    sales: 'बिक्री और GST',
    other: 'स्टॉक, खरीद, ग्राहक और ब्रांड',
  },
  salesTile: {
    title: 'नेट बिक्री (GST से पहले)',
    error: 'बिक्री लोड नहीं हो सकी',
    period: { today: 'आज', week: 'इस हफ़्ते', month: 'इस महीने' },
    previous: { today: 'कल', week: 'पिछले हफ़्ते', month: 'पिछले महीने' },
    up: '{previous} से {percent}% ज़्यादा',
    down: '{previous} से {percent}% कम',
    noComparison: '{previous} कोई बिक्री नहीं, तुलना नहीं',
    withGst: 'GST सहित {amount}',
    bills: '{count} बिल',
    average: 'औसत {amount}',
    trend: 'पिछले 14 दिन',
    day: 'दिन',
    netSales: 'नेट बिक्री (GST से पहले)',
    note: 'इनवॉइस, बिल ऑफ़ सप्लाई और डेबिट नोट में से क्रेडिट नोट घटाकर; कैंसल बिल शामिल नहीं।',
    open: 'बिक्री रिपोर्ट खोलें',
  },
};

export const salesReportEnumsHi: Translation<typeof salesReportEnumsEn> = {
  salesIntervals: { day: 'दिन', week: 'हफ़्ता', month: 'महीना' },
  buyerTypes: { b2b: 'B2B (खरीदार के पास GSTIN)', b2c: 'B2C' },
  gstSections: {
    taxable: 'कर योग्य',
    nil_rated: 'निल रेटेड',
    exempt: 'छूट वाली',
    non_gst: 'GST से बाहर',
    bill_of_supply: 'बिल ऑफ़ सप्लाई (कंपोज़िशन)',
  },
};
