import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { createProduct, openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

/** A business with Apex Ultima 1 l: 20 in Hyderabad at ₹400 each, none in Pune. */
async function stocked(name: string) {
  const business = await createBusiness(name);
  const [hyd] = business.stores;
  const product = await createProduct(business);
  const [variant] = product.variants;
  await openingStock(business, String(hyd?.id), [
    { variantId: String(variant?.id), quantity: 20, unitCostPaise: 40_000 },
  ]);
  return { business, variantId: String(variant?.id) };
}

async function onHand(business: Business, storeCode: string): Promise<number | undefined> {
  const stock = await call<{ items: { store: { code: string }; onHand: number }[] }>(
    'GET',
    '/stock',
    { token: business.token },
  );
  return stock.items.find((row) => row.store.code === storeCode)?.onHand;
}

test('a store requests stock, the other approves and dispatches, and it arrives', async ({
  page,
}) => {
  const { business } = await stocked('Transfer Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/transfers');
  await expect(page.getByText('No transfers yet')).toBeVisible();
  await expectUsable(page);

  await page.getByRole('link', { name: '+ Transfer' }).click();
  await expect(page.getByRole('heading', { name: 'Request stock', level: 1 })).toBeVisible();
  await page
    .getByRole('combobox', { name: 'From store' })
    .selectOption({ label: 'HYD · Hyderabad' });
  await page.getByRole('combobox', { name: 'To store' }).selectOption({ label: 'PUN · Pune' });
  await page.getByRole('searchbox', { name: 'Add a product' }).fill('Apex');
  await page.getByRole('button', { name: 'Add APX-1L' }).click();
  await page.getByRole('textbox', { name: 'Quantity of APX-1L' }).fill('5');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Send request' }).click();

  await expect(page.getByRole('heading', { name: 'TR-000001', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/transfers\/[0-9a-f-]+$/);
  await expectUsable(page);

  await page.getByRole('button', { name: 'Approve TR-000001' }).click();
  const approve = page.getByRole('dialog', { name: 'Approve TR-000001' });
  await expect(approve.getByRole('textbox', { name: 'Quantity of APX-1L to approve' })).toHaveValue(
    '5',
  );
  await approve.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText('Transfer approved')).toBeVisible();

  await page.getByRole('button', { name: 'Dispatch TR-000001' }).click();
  await page
    .getByRole('dialog', { name: 'Dispatch TR-000001' })
    .getByRole('button', { name: 'Dispatch', exact: true })
    .click();
  const challan = page.getByRole('region', { name: 'Delivery challan' });
  await expect(challan.getByRole('table', { name: 'Challan lines' })).toContainText('APX-1L');
  await expect(challan).toContainText('₹2,000.00');
  await expectUsable(page);
  expect(await onHand(business, 'HYD')).toBe(15);

  await page.getByRole('button', { name: 'Receive TR-000001' }).click();
  const receive = page.getByRole('dialog', { name: 'Receive TR-000001' });
  await receive.getByRole('textbox', { name: 'Good quantity of APX-1L' }).fill('4');
  await receive.getByRole('textbox', { name: 'Damaged quantity of APX-1L' }).fill('1');
  await receive.getByRole('button', { name: 'Receive', exact: true }).click();
  await expect(page.getByText('Transfer received')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Products' }).getByRole('row').nth(1)).toContainText(
    '5554',
  );
  // 5 arrived, 1 damaged written off.
  expect(await onHand(business, 'PUN')).toBe(4);

  await page.goto('/transfers');
  await expect(page.getByRole('table', { name: 'Transfers' })).toContainText('Received');
});

test('a transfer reads well on a phone @phone', async ({ page }) => {
  const { business, variantId } = await stocked('Phone Transfer Paints');
  const [hyd, pun] = business.stores;
  const transfer = await call<{ id: string }>('POST', '/transfers', {
    token: business.token,
    body: {
      fromStoreId: hyd?.id,
      toStoreId: pun?.id,
      lines: [{ variantId, quantity: 3 }],
    },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/transfers');
  await expect(page.getByRole('link', { name: 'TR-000001' })).toBeVisible();
  await expectUsable(page);

  await page.goto(`/transfers/${transfer.id}`);
  await expect(page.getByRole('heading', { name: 'TR-000001', level: 1 })).toBeVisible();
  await expectUsable(page);

  await page.goto('/transfers/new');
  await expect(page.getByRole('heading', { name: 'Request stock', level: 1 })).toBeVisible();
  await expectUsable(page);
});
