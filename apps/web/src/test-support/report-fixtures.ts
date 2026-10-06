import type { ReportColumn, ReportFilter, ReportPage, ReportSummary } from '../api/reports.js';

const column = (kind: string, key: string, header: string): ReportColumn => ({
  id: `${kind}.${key}`,
  key,
  header,
});
const STORE: ReportFilter = { name: 'storeId', type: 'store' };
const FROM: ReportFilter = { name: 'from', type: 'date' };
const TO: ReportFilter = { name: 'to', type: 'date' };

export const LEADS_REPORT: ReportSummary = {
  kind: 'leads',
  title: 'Leads',
  columns: [
    column('leads', 'number', 'Lead'),
    column('leads', 'stage', 'Stage'),
    column('leads', 'estimatedValue', 'Estimated value (₹)'),
    // A column this version of the app has no name for: the API's header is shown.
    column('leads', 'products', 'Products'),
  ],
  filters: [
    STORE,
    FROM,
    TO,
    { name: 'stage', type: 'enum', values: ['new', 'contacted', 'qualified', 'won', 'lost'] },
    { name: 'source', type: 'enum', values: ['walk_in', 'referral'] },
  ],
};

export const STOCK_REPORT: ReportSummary = {
  kind: 'stock-by-location',
  title: 'Stock by location',
  columns: [column('stock-by-location', 'sku', 'SKU')],
  filters: [STORE, { name: 'inStockOnly', type: 'boolean', default: 'true' }],
};

export const ALL_REPORTS: ReportSummary[] = [
  STOCK_REPORT,
  {
    kind: 'stock-ledger',
    title: 'Stock ledger',
    columns: [],
    filters: [
      { name: 'movementType', type: 'enum', values: ['opening', 'damage', 'count_correction'] },
    ],
  },
  {
    kind: 'transfers',
    title: 'Transfers',
    columns: [],
    filters: [{ name: 'status', type: 'enum', values: ['requested', 'in_transit'] }],
  },
  {
    kind: 'goods-receipts',
    title: 'Goods receipts',
    columns: [],
    filters: [{ name: 'supplierId', type: 'supplier' }],
  },
  LEADS_REPORT,
  {
    kind: 'projects',
    title: 'Projects',
    columns: [],
    filters: [{ name: 'stage', type: 'enum', values: ['identified', 'survey'] }],
  },
  // A report this version of the app does not know yet, with new kinds of filters.
  {
    kind: 'sales',
    title: 'Sales by day',
    columns: [column('sales', 'day', 'Day')],
    filters: [
      { name: 'channel', type: 'enum', values: ['online', 'walk_in'] },
      { name: 'returns', type: 'boolean', default: 'false' },
      { name: 'invoice', type: 'invoice' as ReportFilter['type'] },
    ],
  },
];

export const leadsPage = (rows: ReportPage['rows'], total = rows.length): ReportPage => ({
  kind: 'leads',
  title: 'Leads',
  columns: LEADS_REPORT.columns,
  rows,
  total,
});
