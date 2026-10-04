import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { createProduct, createSupplier, openingStock, reorderRule } from './inventory-support.js';
import { createBusiness, signInWithPassword } from './support.js';

test('opening stock, a damage write-off and balances per store', async ({ page }) => {
  const business = await createBusiness('Stock Paints');
  await createProduct(business, { brand: 'Asian Paints' });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/stock');
  await expect(page.getByText('No stock yet')).toBeVisible();
  await page.getByRole('link', { name: 'Record movement' }).click();
  await expect(page.getByRole('heading', { name: 'Record stock movement' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'HYD · Hyderabad' });
  await page.getByRole('combobox', { name: 'What happened' }).selectOption({
    label: 'Opening stock',
  });
  await page.getByRole('searchbox', { name: 'Add a product' }).fill('apex');
  await page.getByRole('button', { name: 'Add APX-1L' }).click();
  await page.getByRole('textbox', { name: 'Quantity of APX-1L' }).fill('10');
  await page.getByRole('textbox', { name: 'Cost per unit of APX-1L (₹)' }).fill('400');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save movement' }).click();

  await expect(page).toHaveURL(/\/stock\?store=/);
  const balances = page.getByRole('table', { name: 'Stock balances' });
  await expect(balances.getByRole('row').nth(1)).toContainText('HYD');
  await expect(balances.getByRole('row').nth(1)).toContainText('10');
  await expect(balances.getByRole('row').nth(1)).toContainText('₹4,000.00');
  await expectUsable(page);

  // Two tins arrive dented: written off with a reason.
  await page.getByRole('link', { name: 'Record movement' }).click();
  await page.getByRole('combobox', { name: 'What happened' }).selectOption({
    label: 'Damaged or expired',
  });
  await page.getByRole('searchbox', { name: 'Add a product' }).fill('APX-1L');
  await page.getByRole('searchbox', { name: 'Add a product' }).press('Enter');
  await page.getByRole('textbox', { name: 'Quantity of APX-1L' }).fill('2');
  await page.getByRole('button', { name: 'Save movement' }).click();
  await expect(page.getByText('Say why stock is being adjusted or written off')).toBeVisible();
  await page.getByRole('textbox', { name: 'Reason' }).fill('Dented in delivery');
  await page.getByRole('button', { name: 'Save movement' }).click();
  await expect(balances.getByRole('row').nth(1)).toContainText('8');

  // Pune has none.
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'PUN · Pune' });
  await expect(page.getByText('Nothing matches these filters')).toBeVisible();
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'All stores' });
  await expect(balances.getByRole('row')).toHaveCount(2);
});

test('a reorder rule puts a product on the low stock list, ordered from a supplier', async ({
  page,
}) => {
  const business = await createBusiness('Reorder Paints');
  const [hyd] = business.stores;
  const product = await createProduct(business, { brand: 'Asian Paints' });
  const variantId = product.variants[0]?.id ?? '';
  await openingStock(business, hyd?.id ?? '', [{ variantId, quantity: 4, unitCostPaise: 40_000 }]);
  await createSupplier(business, 'Shah Distributors', [variantId]);
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/stock/low');
  await expect(page.getByText('Nothing is low')).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: 'Reorder rules' }).first().click();
  await expect(page.getByRole('heading', { name: 'Reorder rules', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Set reorder levels' }).click();
  const dialog = page.getByRole('dialog', { name: 'Set reorder levels' });
  await dialog.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'HYD · Hyderabad' });
  await dialog.getByRole('searchbox', { name: 'Add a product' }).fill('apex');
  await dialog.getByRole('button', { name: 'Add APX-1L' }).click();
  await dialog.getByRole('textbox', { name: 'Minimum' }).fill('5');
  await dialog.getByRole('textbox', { name: 'Reorder at' }).fill('8');
  await dialog.getByRole('textbox', { name: 'Order up to' }).fill('24');
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const rules = page.getByRole('table', { name: 'Reorder rules' });
  await expect(rules.getByRole('row').nth(1)).toContainText('APX-1L');
  await expectUsable(page);

  await page
    .getByRole('navigation', { name: 'Stock sections' })
    .getByRole('link', {
      name: 'Low stock',
    })
    .click();
  const low = page.getByRole('table', { name: 'Low stock items' });
  await expect(low.getByRole('row').nth(1)).toContainText('Below minimum');
  await expect(low.getByRole('row').nth(1)).toContainText('20');
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'HYD · Hyderabad' });
  await page.getByRole('checkbox', { name: 'Select APX-1L' }).check();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Create purchase order' }).click();
  const order = page.getByRole('dialog', { name: 'Purchase order from low stock' });
  await order.getByRole('combobox', { name: 'Supplier' }).selectOption({
    label: 'Shah Distributors',
  });
  await order.getByRole('button', { name: 'Create order' }).click();
  await expect(page).toHaveURL(/\/purchase-orders\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'PO-000001' })).toBeVisible();
  await expect(page.getByRole('main')).toContainText('APX-1L');
});

test('stock screens fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Stock Paints');
  const [hyd] = business.stores;
  const product = await createProduct(business, { brand: 'Asian Paints' });
  await openingStock(business, hyd?.id ?? '', [
    { variantId: product.variants[0]?.id ?? '', quantity: 6, unitCostPaise: 40_000 },
  ]);
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/stock');
  await expect(page.getByRole('table', { name: 'Stock balances' })).toBeVisible();
  await expectUsable(page);
  await page.goto('/stock/movements/new');
  await page.getByRole('searchbox', { name: 'Add a product' }).fill('apex');
  await page.getByRole('button', { name: 'Add APX-1L' }).click();
  await expect(page.getByRole('textbox', { name: 'Quantity of APX-1L' })).toBeVisible();
  await expectUsable(page);
  await page.goto('/stock/reorder-rules');
  await expect(page.getByText('No reorder rules yet')).toBeVisible();
  await expectUsable(page);
  await reorderRule(business, {
    storeId: hyd?.id ?? '',
    variantId: product.variants[0]?.id ?? '',
    minQuantity: 8,
    reorderLevel: 10,
    maxQuantity: 30,
  });
  await page.goto(`/stock/low?store=${hyd?.id ?? ''}`);
  await expect(page.getByRole('table', { name: 'Low stock items' })).toBeVisible();
  await expectUsable(page);
});
