import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, uniquePhone, type Business } from './support.js';

// Brand profitability (spec §7 Round 5 demo): the owner sees which brand made the most
// money, splits it by product and store, and reads what each figure means.

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
  const paints = categories.find((option) => option.key === 'paints')?.id;
  const product = async (brandName: string, name: string, sku: string, pricePaise: number) => {
    const brand = await call<{ id: string }>('POST', '/brands', {
      token,
      body: { name: brandName },
    });
    const created = await call<{ variants: { id: string }[] }>('POST', '/products', {
      token,
      body: {
        brandId: brand.id,
        name,
        type: 'exterior_paint',
        hsnCode: '3209',
        taxCategoryId: paints,
        variants: [{ sku, packSize: 20, unit: 'l', sellingPricePaise: pricePaise, barcodes: [] }],
      },
    });
    return String(created.variants[0]?.id);
  };
  // Apex: ₹5,000 taxable a pack at ₹4,000 cost; Beauty: ₹2,000 at ₹1,900.
  const apex = await product('Asian Paints', 'Apex Ultima', 'APX-20L', 5_900_00);
  const beauty = await product('Nerolac', 'Beauty Smooth', 'NBS-20L', 2_360_00);
  await openingStock(business, storeId, [
    { variantId: apex, quantity: 10, unitCostPaise: 4_000_00 },
    { variantId: beauty, quantity: 10, unitCostPaise: 1_900_00 },
  ]);
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Suresh Reddy', phone: uniquePhone(), roles: ['customer'] },
  });
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: {
      storeId,
      partyId: party.id,
      lines: [
        { variantId: apex, quantity: 2 },
        { variantId: beauty, quantity: 1 },
      ],
    },
  });
  await call('POST', `/invoices/${draft.id}/issue`, { token, body: {} });
  return business;
}

async function signIn(page: Page, business: Business) {
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
}

test('the owner sees which brand made the most money, and splits it', async ({ page }) => {
  const business = await shop('Profit Paints');
  await signIn(page, business);
  // The sale is today: last quarter, on the dashboard and by default, had none.
  await expect(page.getByRole('heading', { name: 'Top brand last quarter' })).toBeVisible();
  await expect(page.getByText('No sales last quarter')).toBeVisible();
  await page.getByRole('link', { name: 'See brand profitability' }).click();
  await expect(page.getByRole('heading', { name: 'Brand profitability', level: 1 })).toBeVisible();
  await expect(page.getByText('No sales in this period')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How the figures are worked out' })).toBeVisible();
  await expectUsable(page);

  await page.getByLabel('Period').selectOption('thisQuarter');
  const headline = page.getByRole('region', { name: 'Who made the most money' });
  await expect(headline).toContainText('Asian Paints made the most money');
  const table = page.getByRole('table', { name: 'Contribution by brand' });
  const apex = table.getByRole('row', { name: /Asian Paints/ });
  await expect(apex).toContainText('₹10,000.00');
  await expect(apex).toContainText('₹8,000.00');
  await expect(apex).toContainText('₹2,000.00');
  await expect(table.getByRole('row', { name: /Nerolac/ })).toContainText('₹100.00');
  await expect(page.getByText(/Scheme money from brands is not counted yet/)).toBeVisible();
  await expectUsable(page);

  await page.getByRole('button', { name: 'Split Asian Paints by product' }).click();
  await expect(page.getByText('Brand: Asian Paints')).toBeVisible();
  await expect(table.getByRole('rowheader', { name: 'Apex Ultima' })).toBeVisible();
  await expect(table.getByRole('row', { name: /Nerolac/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show all brands' }).click();
  await page.getByLabel('Split by').selectOption('store');
  await expect(table.getByRole('rowheader', { name: 'AMP · Ameerpet' }).first()).toBeVisible();
  await expectUsable(page);
});

test('brand profitability fits a phone @phone', async ({ page }) => {
  const business = await shop('Phone Profit Paints');
  await signIn(page, business);
  await page.goto('/reports/brand-profitability?period=thisQuarter&groupBy=product');
  await expect(page.getByRole('region', { name: 'Who made the most money' })).toContainText(
    'Asian Paints made the most money',
  );
  await expect(page.getByRole('rowheader', { name: 'Beauty Smooth' })).toBeVisible();
  await expectUsable(page);
});
