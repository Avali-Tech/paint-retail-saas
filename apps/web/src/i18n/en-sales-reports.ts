// English messages for the sales reports, the GST summary and the dashboard's sales tile
// (MVP 3 round 7b). The kinds, columns and filters are spread into en-reports.ts.

export const salesReportKindsEn = {
  'sales-by-period': {
    title: 'Sales by day',
    description: 'Net sales by day, week or month: bills, credit notes, GST and the average bill',
  },
  'sales-by-store': {
    title: 'Sales by store',
    description: 'Net sales at each store, with its share of the total',
  },
  'sales-by-product': {
    title: 'Sales by product',
    description: 'Each pack’s net units, litres and sales value',
  },
  'sales-by-brand': {
    title: 'Sales by brand',
    description: 'Net units, litres and sales value of each brand',
  },
  'sales-by-category': {
    title: 'Sales by category',
    description: 'Net units, litres and sales value of each product category',
  },
  'sales-by-salesperson': {
    title: 'Sales by salesperson',
    description: 'Net sales of the bills each person issued',
  },
  'sales-by-customer': {
    title: 'Sales by customer',
    description: 'Your top customers by net sales, with their last bill',
  },
  'payments-by-mode': {
    title: 'Collections by payment mode',
    description: 'Money received and refunded each day by store and mode, as the day end counts it',
  },
  'gst-summary': {
    title: 'GST summary',
    description:
      'Taxable value and tax by GSTIN and rate, B2B and B2C, credit notes netted. Not a GSTR-1 filing',
  },
  'gst-hsn-summary': {
    title: 'GST summary by HSN',
    description: 'Quantity, taxable value and tax for each HSN code and rate',
  },
};

const sales = {
  bills: 'Bills',
  creditNotes: 'Credit notes',
  taxable: 'Net sales (₹, before GST)',
  tax: 'GST (₹)',
  value: 'Net sales with GST (₹)',
  averageBill: 'Average bill (₹, before GST)',
};
const quantities = { quantity: 'Quantity (net)', litres: 'Litres (net)' };
const share = 'Share of net sales (%)';
const gstHeads = {
  taxable: 'Taxable value (₹)',
  cgst: 'CGST (₹)',
  sgst: 'SGST / UTGST (₹)',
  igst: 'IGST (₹)',
  cess: 'Cess (₹)',
  tax: 'Total tax (₹)',
};

export const salesReportColumnsEn = {
  'sales-by-period': { period: 'Day, week (from Monday) or month', ...sales },
  'sales-by-store': { store: 'Store', name: 'Name', gstin: 'GSTIN', ...sales, share },
  'sales-by-product': {
    sku: 'SKU',
    brand: 'Brand',
    product: 'Product',
    variant: 'Size / pack',
    category: 'Category',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-brand': {
    brand: 'Brand',
    products: 'Packs sold',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-category': {
    category: 'Category',
    products: 'Packs sold',
    ...quantities,
    bills: sales.bills,
    creditNotes: sales.creditNotes,
    taxable: sales.taxable,
    tax: sales.tax,
    value: sales.value,
    share,
  },
  'sales-by-salesperson': {
    salesperson: 'Salesperson (issued the bill)',
    customers: 'Customers',
    ...sales,
    share,
  },
  'sales-by-customer': {
    customer: 'Customer',
    phone: 'Mobile',
    customerType: 'Customer type',
    gstin: 'GSTIN',
    lastBilled: 'Last billed',
    ...sales,
    share,
  },
  'payments-by-mode': {
    day: 'Date',
    store: 'Store',
    mode: 'Payment mode',
    modeKind: 'Kind',
    payments: 'Payments',
    received: 'Received (₹)',
    atCounter: 'Of which at a counter (₹)',
    refunded: 'Refunded (₹)',
    net: 'Net (₹)',
    bounced: 'Cheques bounced since (₹)',
  },
  'gst-summary': {
    gstin: 'Our GSTIN',
    stores: 'Stores',
    section: 'Supply',
    rate: 'GST rate (%)',
    cessRate: 'Cess rate (%)',
    buyerType: 'B2B / B2C',
    supplyType: 'Intra / inter-state',
    documents: 'Documents',
    creditNotes: 'Of which credit notes',
    ...gstHeads,
  },
  'gst-hsn-summary': {
    gstin: 'Our GSTIN',
    hsn: 'HSN',
    uqc: 'Unit (UQC)',
    section: 'Supply',
    rate: 'GST rate (%)',
    quantity: 'Quantity (net)',
    ...gstHeads,
    value: 'Total value (₹)',
  },
};

export const salesReportFiltersEn = {
  interval: 'Group by',
  kind: 'Document',
  buyerType: 'B2B / B2C',
  customerType: 'Customer type',
  salespersonId: 'Salesperson (issued the bill)',
  customerSalespersonId: 'Customer’s salesperson',
  brandId: 'Brand',
  categoryId: 'Category',
  product: 'Product or SKU',
  modeKind: 'Payment mode',
};

export const salesReportsEn = {
  reportSections: {
    sales: 'Sales and GST',
    other: 'Stock, purchases, customers and brands',
  },
  salesTile: {
    title: 'Net sales (before GST)',
    error: 'Could not load sales',
    period: { today: 'Today', week: 'This week', month: 'This month' },
    previous: { today: 'yesterday', week: 'last week', month: 'last month' },
    up: 'Up {percent}% on {previous}',
    down: 'Down {percent}% on {previous}',
    noComparison: 'No sales {previous} to compare',
    withGst: '{amount} with GST',
    bills: '{count} bills',
    average: 'average {amount}',
    trend: 'Last 14 days',
    day: 'Day',
    netSales: 'Net sales (before GST)',
    note: 'Invoices, bills of supply and debit notes less credit notes; cancelled bills are left out.',
    open: 'Open the sales reports',
  },
};

export const salesReportEnumsEn = {
  salesIntervals: { day: 'Day', week: 'Week', month: 'Month' },
  buyerTypes: { b2b: 'B2B (buyer has a GSTIN)', b2c: 'B2C' },
  gstSections: {
    taxable: 'Taxable',
    nil_rated: 'Nil rated',
    exempt: 'Exempt',
    non_gst: 'Non-GST',
    bill_of_supply: 'Bill of supply (composition)',
  },
};
