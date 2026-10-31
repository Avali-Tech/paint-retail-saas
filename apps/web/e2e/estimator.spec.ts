import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import {
  call,
  createBusiness,
  signInWithPassword,
  type Business,
  openFromMenu,
} from './support.js';

// The paint estimator (spec §6.2, §7 Round 5 demo): rooms → litres → packs, good /
// better / best, and a quotation from one tier.

interface Shop {
  readonly business: Business;
}

/** A shop with three emulsions (good, better, best), a primer and a putty, and a customer. */
async function shop(name: string): Promise<Shop> {
  const business = await createBusiness(name, [['AMP', 'Ameerpet']]);
  const { token } = business;
  // Quotes need a GST-registered store.
  await call('PUT', '/gst-registrations/business', { token, body: { legalName: `${name} LLP` } });
  await call('PUT', `/gst-registrations/stores/${String(business.stores[0]?.id)}`, {
    token,
    body: { registrationType: 'regular', stateCode: '36', gstin: '36AABCS1429B1ZV' },
  });
  const { categories } = await call<{ categories: { id: string; key: string | null }[] }>(
    'GET',
    '/tax-categories/options',
    { token },
  );
  const taxCategoryId = categories.find((option) => option.key === 'paints')?.id;
  const brand = await call<{ id: string }>('POST', '/brands', {
    token,
    body: { name: 'Asian Paints' },
  });
  const product = (
    productName: string,
    type: string,
    coverageSqftPerLitre: number | null,
    packs: [string, number, number][],
    unit = 'l',
  ) =>
    call('POST', '/products', {
      token,
      body: {
        brandId: brand.id,
        name: productName,
        type,
        hsnCode: type === 'putty' ? '3214' : '3209',
        taxCategoryId,
        ...(coverageSqftPerLitre === null ? {} : { coverageSqftPerLitre }),
        variants: packs.map(([sku, packSize, sellingPricePaise]) => ({
          sku,
          packSize,
          unit,
          sellingPricePaise,
          barcodes: [],
        })),
      },
    });
  await product('Tractor Emulsion', 'interior_paint', 120, [
    ['TRC-20L', 20, 4_000_00],
    ['TRC-4L', 4, 900_00],
    ['TRC-1L', 1, 250_00],
  ]);
  await product('Apcolite Premium', 'interior_paint', 130, [
    ['APC-10L', 10, 4_200_00],
    ['APC-4L', 4, 1_800_00],
  ]);
  await product('Royale Luxury', 'interior_paint', 140, [
    ['ROY-10L', 10, 7_500_00],
    ['ROY-1L', 1, 820_00],
  ]);
  await product('Wall Primer', 'primer', 135, [['PRM-10L', 10, 1_500_00]]);
  await product('Wall Putty', 'putty', null, [['PUT-20KG', 20, 1_100_00]], 'kg');
  await call('POST', '/parties', {
    token,
    body: { displayName: 'Reddy Homes', roles: ['customer'] },
  });
  return { business };
}

async function room(page: Page, legend: string, values: Record<string, string>) {
  const group = page.getByRole('group', { name: legend });
  // The name last: the room's legend follows it.
  const fields = Object.entries(values).sort(
    ([a], [b]) => Number(a === 'Room') - Number(b === 'Room'),
  );
  for (const [field, value] of fields) {
    await group.getByRole('textbox', { name: field, exact: true }).fill(value);
  }
}

async function chooseProduct(page: Page, slot: string, search: string, name: string) {
  await page.getByRole('button', { name: `Change: ${slot}` }).click();
  await page.getByRole('searchbox', { name: `Search products for ${slot}` }).fill(search);
  await page.getByRole('button', { name: `Choose Asian Paints ${name}` }).click();
}

test('the estimate screen measures rooms as they are typed', async ({ page }) => {
  const { business } = await shop('Measure Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/estimates/new');
  await expect(page.getByRole('heading', { name: 'New estimate', level: 1 })).toBeVisible();
  await room(page, 'Room 1', { Room: 'Hall', 'Length (ft)': '14', 'Width (ft)': '12' });
  await expect(page.getByRole('group', { name: 'Hall' }).getByRole('status')).toHaveText(
    '483 sq ft to paint',
  );
  await page.getByRole('button', { name: 'Add room' }).click();
  await room(page, 'Room 2', { Room: 'Bedroom', 'Length (ft)': '12', 'Width (ft)': '10' });
  await expect(page.getByText('Total: 886 sq ft')).toBeVisible();
  await expectUsable(page);
});

test('a 3-room estimate becomes a quotation in under 3 minutes', async ({ page }) => {
  test.setTimeout(180_000);
  const { business } = await shop('Estimate Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  const started = Date.now();
  await openFromMenu(page, 'Sales', 'Estimates');
  await page.getByRole('link', { name: 'New estimate' }).click();
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'AMP · Ameerpet' });
  await page.getByRole('button', { name: 'Choose Customer' }).click();
  await page.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill('Reddy');
  await page.getByRole('button', { name: 'Choose Reddy Homes' }).click();

  await room(page, 'Room 1', { Room: 'Hall', 'Length (ft)': '14', 'Width (ft)': '12' });
  await page.getByRole('group', { name: 'Hall' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Add room' }).click();
  await room(page, 'Room 2', { Room: 'Bedroom', 'Length (ft)': '12', 'Width (ft)': '10' });
  await page.getByRole('button', { name: 'Add room' }).click();
  await room(page, 'Room 3', { Room: 'Kitchen', 'Length (ft)': '10', 'Width (ft)': '8' });
  await expect(page.getByText('Total: 1,377 sq ft')).toBeVisible();

  await chooseProduct(page, 'Good', 'tractor', 'Tractor Emulsion');
  await chooseProduct(page, 'Better', 'apcolite', 'Apcolite Premium');
  await chooseProduct(page, 'Best', 'royale', 'Royale Luxury');
  const good = page.getByRole('region', { name: 'Good', exact: true });
  // 1,377 sq ft × 2 coats ÷ 120 × 1.05 = 24.1 L → 20 L + 4 L + 1 L, not 20 L + 2 × 4 L.
  await expect(good).toContainText('24.1 L of paint');
  await expect(good).toContainText('1 × Asian Paints Tractor Emulsion 20 l');
  await expect(good).toContainText('1 × Asian Paints Tractor Emulsion 4 l');
  await expect(good).toContainText('1 × Asian Paints Tractor Emulsion 1 l');
  await expectUsable(page);

  await page
    .getByRole('region', { name: 'Better', exact: true })
    .getByRole('button', { name: 'Make quotation: Better' })
    .click();
  await expect(
    page.getByRole('heading', { name: /^Quotation QT-\d+ v1$/, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Lines' })).toContainText('Apcolite Premium');
  expect(Date.now() - started).toBeLessThan(180_000);
});
