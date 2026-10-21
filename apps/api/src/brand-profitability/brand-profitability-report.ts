import {
  BRAND_PROFITABILITY_PERMISSION,
  PROFITABILITY_GROUPS,
  type MarginFigures,
} from '@paint/shared';
import {
  dateFilter,
  enumFilter,
  storeFilter,
  type ReportFilter,
} from '../reports/report-filters.js';
import type { ComputedReportKind, ReportRow } from '../reports/report-kinds.js';
import { rupees } from '../reports/report-values.js';
import { brandProfitability } from './brand-profitability.js';
import {
  brandProfitabilitySchema,
  type BrandProfitabilityInput,
} from './brand-profitability.schemas.js';
import { schemeMoney } from './scheme-money.js';

// Brand profitability as CSV, through the reports framework (roadmap P2-M35): the same
// figures as GET /reports/brand-profitability, a row per brand or per brand and product
// or store, then the total.

const figureCells = (figures: MarginFigures) => ({
  netSales: rupees(figures.netSalesPaise),
  cost: rupees(figures.costPaise),
  grossMargin: rupees(figures.grossMarginPaise),
  schemesReceived: rupees(figures.schemeReceivedPaise),
  schemesExpected: rupees(figures.schemeExpectedPaise),
  creditCost: rupees(figures.creditCostPaise),
  loyalty: rupees(figures.loyaltyPaise),
  painterPoints: rupees(figures.painterPointsPaise),
  contribution: rupees(figures.contributionPaise),
  margin: figures.marginBps === null ? null : (figures.marginBps / 100).toFixed(2),
});

const filterInfo: ReportFilter[] = [
  { name: 'from', ...dateFilter.info },
  { name: 'to', ...dateFilter.info },
  { name: 'storeId', ...storeFilter.info },
  { name: 'groupBy', ...enumFilter(PROFITABILITY_GROUPS).info },
];

export const brandProfitabilityReport: ComputedReportKind<BrandProfitabilityInput> = {
  kind: 'brand-profitability',
  title: 'Brand profitability',
  permission: BRAND_PROFITABILITY_PERMISSION,
  needsCosts: true,
  columns: [
    { key: 'brand', header: 'Brand' },
    { key: 'product', header: 'Product' },
    { key: 'store', header: 'Store' },
    { key: 'netSales', header: 'Net sales (₹)' },
    { key: 'cost', header: 'Cost of sales (₹)' },
    { key: 'grossMargin', header: 'Gross margin (₹)' },
    { key: 'schemesReceived', header: 'Schemes received (₹)' },
    { key: 'schemesExpected', header: 'Schemes expected (₹)' },
    { key: 'creditCost', header: 'Credit cost (₹)' },
    { key: 'loyalty', header: 'Loyalty points (₹)' },
    { key: 'painterPoints', header: 'Painter points (₹)' },
    { key: 'contribution', header: 'Contribution (₹)' },
    { key: 'margin', header: 'Margin (%)' },
  ],
  filters: brandProfitabilitySchema,
  filterInfo,
  async rows(tx, auth, filters): Promise<ReportRow[]> {
    const view = await brandProfitability(tx, auth, filters, schemeMoney);
    const rows = view.brands.flatMap((brand): ReportRow[] =>
      view.groupBy === 'brand'
        ? [{ brand: brand.brandName, product: null, store: null, ...figureCells(brand.figures) }]
        : brand.slices.map((slice) => ({
            brand: brand.brandName,
            product: slice.productName,
            store: slice.storeCode,
            ...figureCells(slice),
          })),
    );
    return [...rows, { brand: 'Total', product: null, store: null, ...figureCells(view.total) }];
  },
};
