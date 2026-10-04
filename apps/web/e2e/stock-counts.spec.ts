import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { createProduct, openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

/** Hyderabad holds 10 of Apex 1 l and 3 of Apex 4 l. */
async function stocked(name: string) {
  const business = await createBusiness(name);
  const product = await createProduct(business, {
    variants: [
      { sku: 'APX-1L', packSize: 1, mrpPaise: 50_000 },
      { sku: 'APX-4L', packSize: 4, mrpPaise: 170_000 },
    ],
  });
  const [one, four] = product.variants;
  await openingStock(business, String(business.stores[0]?.id), [
    { variantId: String(one?.id), quantity: 10, unitCostPaise: 40_000 },
    { variantId: String(four?.id), quantity: 3, unitCostPaise: 150_000 },
  ]);
  return business;
}

async function onHand(business: Business, sku: string): Promise<number | undefined> {
  const stock = await call<{ items: { variant: { sku: string }; onHand: number }[] }>(
    'GET',
    '/stock',
    { token: business.token },
  );
  return stock.items.find((row) => row.variant.sku === sku)?.onHand;
}

test('a store is counted by scanning, submitted and approved with reasons', async ({ page }) => {
  const business = await stocked('Count Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/stock-counts');
  await expect(page.getByText('No stock counts yet')).toBeVisible();
  await expectUsable(page);

  await page.getByRole('link', { name: '+ Stock count' }).click();
  // The list has a store filter too: wait for the new count's screen to load.
  await expect(page.getByRole('heading', { name: 'Start a stock count', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'HYD · Hyderabad' });
  await expectUsable(page);
  await page.getByRole('button', { name: 'Start count' }).click();

  await expect(page.getByRole('heading', { name: 'SC-000001', level: 1 })).toBeVisible();
  await expect(page.getByText('0 of 2')).toBeVisible();
  await expectUsable(page);

  const scan = page.getByRole('textbox', { name: 'Scan or type a barcode or SKU' });
  await scan.fill('APX-1L');
  await scan.press('Enter');
  await expect(page.getByText('APX-1L: 1 counted')).toBeVisible();
  await expect(scan).toBeFocused();
  await scan.fill('apx-1l');
  await scan.press('Enter');
  await expect(page.getByText('APX-1L: 2 counted')).toBeVisible();

  const count = page.getByRole('textbox', { name: 'Count of APX-1L' });
  await expect(count).toHaveValue('2');
  await count.fill('9');
  await page.getByRole('button', { name: 'Save counts' }).click();
  await expect(page.getByText('Counts saved')).toBeVisible();

  await page.getByRole('button', { name: 'Submit for approval SC-000001' }).click();
  const submit = page.getByRole('dialog', { name: 'Submit SC-000001' });
  await expect(submit).toContainText('1 products not counted yet');
  await submit.getByRole('checkbox', { name: /Count what is left as zero/ }).check();
  await submit.getByRole('button', { name: 'Submit for approval' }).click();
  await expect(page.getByText('Count submitted')).toBeVisible();

  await page.getByRole('button', { name: 'Approve SC-000001' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve SC-000001' });
  await approve
    .getByRole('combobox', { name: 'Reason for APX-1L' })
    .selectOption({ label: 'Damage' });
  await approve
    .getByRole('combobox', { name: 'Reason for APX-4L' })
    .selectOption({ label: 'Theft' });
  await expectUsable(page);
  await approve.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Count approved; stock corrected')).toBeVisible();

  expect(await onHand(business, 'APX-1L')).toBe(9);
  expect(await onHand(business, 'APX-4L')).toBe(0);
  await page.goto('/stock-counts');
  await expect(page.getByRole('table', { name: 'Accuracy by store' })).toContainText('SC-000001');
});

test('counting on a phone @phone', async ({ page }) => {
  const business = await stocked('Phone Count Paints');
  const started = await call<{ id: string }>('POST', '/stock-counts', {
    token: business.token,
    body: { storeId: business.stores[0]?.id },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/stock-counts');
  await expect(page.getByRole('link', { name: 'SC-000001' })).toBeVisible();
  await expectUsable(page);

  await page.goto(`/stock-counts/${started.id}`);
  const scan = page.getByRole('textbox', { name: 'Scan or type a barcode or SKU' });
  await scan.fill('APX-4L');
  await scan.press('Enter');
  await expect(page.getByText('APX-4L: 1 counted')).toBeVisible();
  await expectUsable(page);
});
