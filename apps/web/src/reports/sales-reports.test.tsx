import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ReportPage, ReportSummary } from '../api/reports.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';

// The sales reports and the GST summary on the generic report screens (MVP 3 round 7b).

const SALES_BY_PRODUCT: ReportSummary = {
  kind: 'sales-by-product',
  title: 'Sales by product',
  columns: [
    { id: 'sales-by-product.sku', key: 'sku', header: 'SKU' },
    { id: 'sales-by-product.taxable', key: 'taxable', header: 'Net sales (₹, before GST)' },
  ],
  filters: [
    { name: 'salespersonId', type: 'member' },
    { name: 'brandId', type: 'brand' },
    { name: 'categoryId', type: 'category' },
    { name: 'product', type: 'text' },
  ],
};
const GST_SUMMARY: ReportSummary = {
  kind: 'gst-summary',
  title: 'GST summary',
  columns: [
    { id: 'gst-summary.section', key: 'section', header: 'Supply' },
    { id: 'gst-summary.buyerType', key: 'buyerType', header: 'B2B / B2C' },
    { id: 'gst-summary.taxable', key: 'taxable', header: 'Taxable value (₹)' },
  ],
  filters: [],
};
const STOCK: ReportSummary = {
  kind: 'stock-ledger',
  title: 'Stock ledger',
  columns: [],
  filters: [],
};

const page = (report: ReportSummary, rows: ReportPage['rows']): ReportPage => ({
  kind: report.kind,
  title: report.title,
  columns: report.columns,
  rows,
  total: rows.length,
});
const MEMBERS = [
  {
    id: 'member-2',
    user: { id: 'user-2', fullName: 'Ravi Sales', phone: null, email: null },
    role: { id: 'role-1', key: 'sales_executive', name: 'Sales Executive' },
    allStores: false,
    storeIds: [],
    isActive: true,
    twoFactorEnabled: false,
  },
];

function renderReport(path: string, member = OWNER) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /reports': () => json([STOCK, SALES_BY_PRODUCT, GST_SUMMARY]),
      'GET /reports/sales-by-product': () =>
        json(page(SALES_BY_PRODUCT, [{ sku: 'APX-1L', taxable: '4204.00' }])),
      'GET /reports/gst-summary': () =>
        json(page(GST_SUMMARY, [{ section: 'nil_rated', buyerType: 'b2c', taxable: '30.00' }])),
      'GET /brands': () => json([{ id: 'brand-1', name: 'Berger Paints' }]),
      'GET /categories': () => json([{ id: 'category-1', name: 'Primers' }]),
      'GET /members': () => json(MEMBERS),
    },
  });
}

describe('the sales reports', { timeout: 30_000 }, () => {
  it('come first on the reports page, under their own heading', async () => {
    renderReport('/reports');
    const sales = await screen.findByRole('region', { name: 'Sales and GST' });
    expect(within(sales).getByRole('link', { name: 'Open GST summary' })).toBeVisible();
    expect(within(sales).queryByRole('link', { name: 'Open Stock ledger' })).toBeNull();
    const other = screen.getByRole('region', { name: 'Stock, purchases, customers and brands' });
    expect(within(other).getByRole('link', { name: 'Open Stock ledger' })).toBeVisible();
  });

  it('filter by salesperson, brand, category and product', async () => {
    const { user, requests } = renderReport('/reports/sales-by-product');
    expect(await screen.findByRole('cell', { name: 'APX-1L' })).toBeVisible();
    await user.selectOptions(await screen.findByLabelText('Brand'), 'Berger Paints');
    await user.selectOptions(screen.getByLabelText('Category'), 'Primers');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Salesperson (issued the bill)' }),
      'Ravi Sales',
    );
    await user.type(screen.getByLabelText('Product or SKU'), 'apex');
    await waitFor(() => {
      const last = requests.filter((r) => r.path === '/reports/sales-by-product').at(-1);
      expect(Object.fromEntries(last?.query ?? [])).toMatchObject({
        brandId: 'brand-1',
        categoryId: 'category-1',
        salespersonId: 'member-2',
        product: 'apex',
      });
    });
  });

  it('offer a member who cannot see the team only themself as the salesperson', async () => {
    renderReport('/reports/sales-by-product', profile(['sales:read', 'catalog:read']));
    const picker = await screen.findByRole('combobox', { name: 'Salesperson (issued the bill)' });
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Any', 'Me']);
  });

  it('show the GST summary’s codes by their names', async () => {
    renderReport('/reports/gst-summary');
    const table = await screen.findByRole('table', { name: 'GST summary' });
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Nil ratedB2C30.00');
  });
});
