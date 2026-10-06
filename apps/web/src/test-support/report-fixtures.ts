import type { ReportPage, ReportSummary } from '../api/reports.js';

export const LEADS_REPORT: ReportSummary = {
  kind: 'leads',
  title: 'Leads',
  columns: [
    { key: 'number', header: 'Lead' },
    { key: 'stage', header: 'Stage' },
    { key: 'estimatedValue', header: 'Estimated value (₹)' },
    { key: 'products', header: 'Products' },
  ],
  filters: ['storeId', 'from', 'to', 'stage', 'source'],
};

export const STOCK_REPORT: ReportSummary = {
  kind: 'stock-by-location',
  title: 'Stock by location',
  columns: [{ key: 'sku', header: 'SKU' }],
  filters: ['storeId', 'inStockOnly'],
};

export const ALL_REPORTS: ReportSummary[] = [
  STOCK_REPORT,
  { kind: 'stock-ledger', title: 'Stock ledger', columns: [], filters: ['movementType'] },
  { kind: 'transfers', title: 'Transfers', columns: [], filters: ['status'] },
  { kind: 'goods-receipts', title: 'Goods receipts', columns: [], filters: ['supplierId'] },
  LEADS_REPORT,
  { kind: 'projects', title: 'Projects', columns: [], filters: ['stage'] },
  // A report this version of the app does not know yet.
  { kind: 'sales', title: 'Sales by day', columns: [], filters: ['channel'] },
];

export const leadsPage = (rows: ReportPage['rows'], total = rows.length): ReportPage => ({
  kind: 'leads',
  title: 'Leads',
  columns: LEADS_REPORT.columns,
  rows,
  total,
});
