import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { createProduct, createSupplier } from './inventory-support.js';
import { call, createBusiness, signInWithPassword } from './support.js';

test('a supplier, an order, goods received with free units, then closed short', async ({
  page,
}) => {
  // The whole purchasing cycle in one go: more steps than the default timeout allows.
  test.slow();
  const business = await createBusiness('Purchase Paints');
  const [hyd] = business.stores;
  await createProduct(business, { brand: 'Asian Paints' });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // A new supplier with terms and a product.
  await page.goto('/suppliers');
  await expect(page.getByText('No suppliers yet')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: '+ Supplier' }).click();
  const dialog = page.getByRole('dialog', { name: 'New supplier' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill('Shah Distributors');
  await dialog.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByRole('heading', { name: 'Shah Distributors', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/suppliers\/[0-9a-f-]+$/);

  await page.getByRole('button', { name: 'Edit terms' }).click();
  const terms = page.getByRole('dialog', { name: 'Payment terms and lead time' });
  await terms.getByRole('textbox', { name: 'Days of credit' }).fill('30');
  await terms.getByRole('textbox', { name: 'Lead time in days' }).fill('4');
  await terms.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Terms saved')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Terms' })).toContainText('30 days');

  await page.getByRole('searchbox', { name: 'Add a product' }).fill('apex');
  await page.getByRole('button', { name: 'Add APX-1L' }).click();
  await page.getByRole('textbox', { name: "Supplier's code for APX-1L" }).fill('SH-1');
  await page.getByRole('button', { name: 'Save products' }).click();
  await expect(page.getByText('Products saved')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Products supplied' })).toContainText('SH-1');
  await expectUsable(page);

  // An order for 10 at ₹400.
  await page.getByRole('link', { name: 'New purchase order' }).click();
  await expect(page.getByRole('heading', { name: 'New purchase order' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'HYD · Hyderabad' });
  await page.getByRole('button', { name: "Add the supplier's products" }).click();
  await page.getByRole('textbox', { name: 'Quantity of APX-1L', exact: true }).fill('10');
  await page.getByRole('textbox', { name: 'Cost per unit of APX-1L (₹)' }).fill('400');
  await expect(page.getByText('Total of known costs ₹4,000.00')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Create order' }).click();
  await expect(page.getByRole('heading', { name: 'PO-000001' })).toBeVisible();
  await expect(page.getByRole('main').getByText('Open', { exact: true })).toBeVisible();
  await expectUsable(page);

  // 6 arrive with 1 free.
  await page.getByRole('link', { name: 'Receive goods' }).click();
  await expect(page.getByText(/Against PO-000001 from Shah Distributors/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Quantity of APX-1L', exact: true }).fill('6');
  await page.getByRole('textbox', { name: 'Free quantity of APX-1L' }).fill('1');
  await expect(page.getByText('Total ₹2,400.00')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await expect(page.getByRole('heading', { name: 'GRN-000001' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Products' })).toContainText('61₹400.00₹2,400.00');
  await expectUsable(page);

  await page.getByRole('link', { name: 'PO-000001' }).click();
  await expect(page.getByRole('main').getByText('Partly received', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close short' }).click();
  const close = page.getByRole('dialog', { name: 'Close PO-000001 short' });
  await close.getByRole('textbox', { name: 'Reason' }).fill('The rest is not coming');
  await close.getByRole('button', { name: 'Close short' }).click();
  await expect(page.getByText('Order closed')).toBeVisible();
  await expect(page.getByRole('main').getByText('Closed short', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Receive goods' })).toHaveCount(0);

  // 6 paid + 1 free are on the shelf at Hyderabad.
  await page.goto(`/stock?store=${String(hyd?.id)}`);
  const row = page.getByRole('row', { name: /APX-1L/ });
  await expect(row.getByRole('cell').nth(0)).toHaveText('HYD');
  await expect(row.getByRole('cell').nth(1)).toHaveText('7');

  // A direct receipt against a supplier invoice, found by scanning the SKU.
  await page.goto('/goods-receipts/new');
  await page
    .getByRole('combobox', { name: 'Supplier' })
    .selectOption({ label: 'Shah Distributors' });
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'HYD · Hyderabad' });
  await page.getByRole('textbox', { name: 'Supplier invoice number' }).fill('INV-501');
  await page.getByRole('searchbox', { name: 'Add a product' }).fill('APX-1L');
  await page.getByRole('searchbox', { name: 'Add a product' }).press('Enter');
  await page.getByRole('textbox', { name: 'Quantity of APX-1L', exact: true }).fill('2');
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await expect(page.getByRole('heading', { name: 'GRN-000002' })).toBeVisible();
  await expect(page.getByText('INV-501')).toBeVisible();

  await page.goto('/goods-receipts');
  await expect(page.getByRole('table', { name: 'Goods receipts' }).getByRole('row')).toHaveCount(3);
  await expectUsable(page);
  await page.goto('/purchase-orders');
  await expect(page.getByRole('table', { name: 'Purchase orders' })).toContainText('Closed short');
  await expectUsable(page);
});

test('goods arrive on a phone against an invoice @phone', async ({ page }) => {
  const business = await createBusiness('Phone Purchase Paints');
  const product = await createProduct(business, { brand: 'Berger' });
  await createSupplier(
    business,
    'Ravi Traders',
    product.variants.map((variant) => variant.id),
  );
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/goods-receipts/new');
  await expect(page.getByRole('heading', { name: 'Receive goods', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Supplier' }).selectOption({ label: 'Ravi Traders' });
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'HYD · Hyderabad' });
  await page.getByRole('textbox', { name: 'Supplier invoice number' }).fill('RT-9');
  await page.getByRole('searchbox', { name: 'Add a product' }).fill('apex');
  await page.getByRole('button', { name: 'Add APX-1L' }).click();
  await page.getByRole('textbox', { name: 'Quantity of APX-1L', exact: true }).fill('12');
  await page.getByRole('textbox', { name: 'Free quantity of APX-1L' }).fill('2');
  await page.getByRole('textbox', { name: 'Cost per unit of APX-1L (₹)' }).fill('380');
  await expect(page.getByText('Total ₹4,560.00')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save receipt' }).click();
  await expect(page.getByRole('heading', { name: 'GRN-000001' })).toBeVisible();
  await expectUsable(page);
});

test('suppliers and purchase orders fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Order Paints');
  const product = await createProduct(business, { brand: 'Berger' });
  const supplierId = await createSupplier(
    business,
    'Ravi Traders',
    product.variants.map((variant) => variant.id),
  );
  const order = await call<{ id: string }>('POST', '/purchase-orders', {
    token: business.token,
    body: {
      supplierId,
      storeId: business.stores[0]?.id,
      lines: product.variants.map((variant) => ({
        variantId: variant.id,
        quantity: 12,
        unitCostPaise: 38_000,
      })),
    },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/suppliers');
  await expect(page.getByRole('link', { name: 'Ravi Traders' })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: 'Ravi Traders' }).click();
  await expect(page.getByRole('heading', { name: 'Ravi Traders', level: 1 })).toBeVisible();
  await expectUsable(page);
  await page.goto('/purchase-orders');
  await expect(page.getByRole('link', { name: 'PO-000001' })).toBeVisible();
  await expectUsable(page);
  await page.goto(`/purchase-orders/${order.id}`);
  await expect(page.getByRole('heading', { name: 'PO-000001', level: 1 })).toBeVisible();
  await expectUsable(page);
  await page.goto('/purchase-orders/new');
  await expect(page.getByRole('heading', { name: 'New purchase order', level: 1 })).toBeVisible();
  await expectUsable(page);
  await page.goto('/goods-receipts');
  await expect(page.getByRole('heading', { name: 'Goods receipts', level: 1 })).toBeVisible();
  await expectUsable(page);
});
