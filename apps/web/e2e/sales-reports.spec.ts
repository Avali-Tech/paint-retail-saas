import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, uniquePhone } from './support.js';

// Sales by influencer and by site (spec §6.4, §7 Round 5 demo): a homeowner's invoice
// credits the painter under the right site.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

test('a homeowner’s invoice credits the painter under the right site', async ({ page }) => {
  const business = await createBusiness('Influencer Paints', [
    ['AMP', 'Ameerpet'],
    ['KPH', 'Kukatpally'],
  ]);
  const { token } = business;
  const storeId = String(business.stores[0]?.id);
  await call('PUT', '/gst-registrations/business', {
    token,
    body: { legalName: 'Influencer LLP' },
  });
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
  const paint = await call<{ variants: { id: string }[] }>('POST', '/products', {
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
  const variantId = String(paint.variants[0]?.id);
  await openingStock(business, storeId, [{ variantId, quantity: 10, unitCostPaise: 4_000_00 }]);
  const party = (displayName: string, roles: string[]) =>
    call<{ id: string }>('POST', '/parties', {
      token,
      body: { displayName, phone: uniquePhone(), roles },
    });
  const homeowner = await party('Suresh Reddy', ['customer']);
  const painter = await party('Ravi the painter', ['painter']);
  const site = await call<{ id: string; number: string }>('POST', '/projects', {
    token,
    body: { storeId, customerPartyId: homeowner.id, name: 'Reddy villa', city: 'Hyderabad' },
  });
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: {
      storeId,
      partyId: homeowner.id,
      influencerPartyId: painter.id,
      projectId: site.id,
      lines: [{ variantId, quantity: 2 }],
    },
  });
  await call('POST', `/invoices/${draft.id}/issue`, { token, body: {} });

  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Reports' })
    .click();
  await page.getByRole('link', { name: 'Open Sales by influencer' }).click();
  const byInfluencer = page.getByRole('table', { name: 'Sales by influencer' });
  const row = byInfluencer.getByRole('row', { name: /Ravi the painter/ });
  await expect(row).toContainText(`${site.number} Reddy villa`);
  await expect(row).toContainText('Suresh Reddy');
  await expect(row).toContainText('11800.00');
  await expectUsable(page);

  await page.goto('/reports/sales-by-site');
  const bySite = page.getByRole('table', { name: 'Sales by site' });
  const siteRow = bySite.getByRole('row', { name: /Reddy villa/ });
  await expect(siteRow).toContainText('Ravi the painter');
  await expect(siteRow).toContainText('10000.00');
  await expectUsable(page);
});
