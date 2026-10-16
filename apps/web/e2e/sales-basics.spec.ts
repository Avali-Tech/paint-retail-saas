import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, uniquePhone, type Business } from './support.js';

// Sales basics for owners (MVP 3 round 7b): the dashboard's sales tile, the sales reports
// and the GST summary, from two bills and a credit note issued today.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

async function shop(name: string): Promise<Business> {
  const business = await createBusiness(name, [['AMP', 'Ameerpet']]);
  const { token } = business;
  const storeId = String(business.stores[0]?.id);
  await call('PUT', '/gst-registrations/business', { token, body: { legalName: `${name} LLP` } });
  await call('PUT', `/gst-registrations/stores/${storeId}`, {
    token,
    body: { registrationType: 'regular', stateCode: '36', gstin: TELANGANA_GSTIN },
  });
  const { categories } = await call<{ categories: { id: string; key: string | null }[] }>(
    'GET',
    '/tax-categories/options',
    { token },
  );
  const brand = await call<{ id: string }>('POST', '/brands', {
    token,
    body: { name: 'Asian Paints' },
  });
  const created = await call<{ variants: { id: string }[] }>('POST', '/products', {
    token,
    body: {
      brandId: brand.id,
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '3209',
      taxCategoryId: categories.find((option) => option.key === 'paints')?.id,
      variants: [
        { sku: 'APX-20L', packSize: 20, unit: 'l', sellingPricePaise: 5_900_00, barcodes: [] },
      ],
    },
  });
  const variantId = String(created.variants[0]?.id);
  await openingStock(business, storeId, [{ variantId, quantity: 10, unitCostPaise: 4_000_00 }]);
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Suresh Reddy', phone: uniquePhone(), roles: ['customer'] },
  });
  // Two bills: ₹10,000 and ₹5,000 before GST; then ₹1,000 credited on the first.
  const bill = async (quantity: number) => {
    const draft = await call<{ id: string }>('POST', '/invoices', {
      token,
      body: { storeId, partyId: party.id, lines: [{ variantId, quantity }] },
    });
    return call<{ id: string; lines: { id: string }[] }>('POST', `/invoices/${draft.id}/issue`, {
      token,
      body: {},
    });
  };
  const first = await bill(2);
  await bill(1);
  await call('POST', '/credit-notes', {
    token,
    body: {
      invoiceId: first.id,
      reason: 'overcharge',
      lines: [{ invoiceLineId: first.lines[0]?.id, valuePaise: 1_180_00 }],
    },
  });
  return business;
}

async function signIn(page: Page, business: Business) {
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

test('the owner reads today’s sales on the dashboard and opens the sales reports', async ({
  page,
}) => {
  const business = await shop('Sales Basics Paints');
  await signIn(page, business);
  const tile = page.locator('.sales-tile');
  await expect(tile.getByRole('heading', { name: 'Net sales (before GST)' })).toBeVisible();
  const today = tile.locator('.sales-tile__period').first();
  await expect(today).toContainText('Today');
  await expect(today).toContainText('₹14,000.00');
  await expect(today).toContainText('₹16,520.00 with GST');
  await expect(today).toContainText('2 bills · average ₹7,500.00');
  await expectUsable(page);

  // Today's figure opens the sales by day for today.
  await today.getByRole('link', { name: '₹14,000.00' }).click();
  const byDay = page.getByRole('table', { name: 'Sales by day' });
  await expect(byDay.getByRole('row').nth(1)).toContainText('14000.00');
  await expectUsable(page);

  await page.goto('/reports');
  const sales = page.getByRole('region', { name: 'Sales and GST' });
  await sales.getByRole('link', { name: 'Open Sales by product' }).click();
  const byProduct = page.getByRole('table', { name: 'Sales by product' });
  await expect(byProduct.getByRole('row', { name: /APX-20L/ })).toContainText('60');
  await expect(byProduct.getByRole('row', { name: /APX-20L/ })).toContainText('14000.00');
  await expectUsable(page);
});

test('the GST summary nets the credit note, rate by rate', async ({ page }) => {
  const business = await shop('GST Summary Paints');
  await signIn(page, business);
  await page.goto('/reports/gst-summary');
  const summary = page.getByRole('table', { name: 'GST summary' });
  const row = summary.getByRole('row', { name: /Taxable/ });
  await expect(row).toContainText(TELANGANA_GSTIN);
  await expect(row).toContainText('B2C');
  await expect(row).toContainText('14000.00');
  await expect(row).toContainText('1260.00');
  await expectUsable(page);
  await page.goto('/reports/gst-hsn-summary');
  await expect(page.getByRole('table', { name: 'GST summary by HSN' })).toContainText('3209');
  await expectUsable(page);
});

test('the sales tile and the GST summary fit a phone @phone', async ({ page }) => {
  const business = await shop('Phone Sales Paints');
  await signIn(page, business);
  await expect(page.locator('.sales-tile')).toContainText('₹14,000.00');
  await expectUsable(page);
  await page.goto('/reports/gst-summary');
  await expect(page.getByRole('table', { name: 'GST summary' })).toContainText('14000.00');
  await expectUsable(page);
});
