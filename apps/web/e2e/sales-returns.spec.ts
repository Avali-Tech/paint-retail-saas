import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { createProduct, openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

// A valid Telangana GSTIN (GSTN check character).
const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Billed {
  readonly business: Business;
  readonly invoice: { id: string; number: string };
}

/** A GST-registered store that sold 3 tins of Apex Ultima (₹450 each, tax included). */
async function billed(name: string): Promise<Billed> {
  const business = await createBusiness(name, [['HYD', 'Hyderabad']]);
  const [store] = business.stores;
  if (!store) throw new Error('The business has a store');
  const product = await createProduct(business);
  const [variant] = product.variants;
  if (!variant) throw new Error('The product has a pack');
  await openingStock(business, store.id, [{ variantId: variant.id, quantity: 10 }]);
  await call('PUT', `/gst-registrations/stores/${store.id}`, {
    token: business.token,
    body: {
      registrationType: 'regular',
      stateCode: '36',
      gstin: TELANGANA_GSTIN,
      legalName: `${name} Private Limited`,
      addressLine: '1-2-3 Main Road',
      city: 'Hyderabad',
      pincode: '500016',
    },
  });
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token: business.token,
    body: { storeId: store.id, lines: [{ variantId: variant.id, quantity: 3 }] },
  });
  const invoice = await call<{ id: string; number: string }>(
    'POST',
    `/invoices/${draft.id}/issue`,
    { token: business.token, body: {} },
  );
  return { business, invoice };
}

async function onHand(business: Business): Promise<number | undefined> {
  const stock = await call<{ items: { variant: { sku: string }; onHand: number }[] }>(
    'GET',
    '/stock',
    { token: business.token },
  );
  return stock.items.find((row) => row.variant.sku === 'APX-1L')?.onHand;
}

/** Signs in as the owner and opens the invoice from the invoice list. */
async function openInvoice(page: Page, { business, invoice }: Billed) {
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/invoices');
  await page
    .getByRole('table', { name: 'Invoices' })
    .getByRole('link', { name: invoice.number })
    .click();
  await expect(
    page.getByRole('heading', { name: `Invoice ${invoice.number}`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/Credit notes can be issued until/)).toBeVisible();
}

test('returns a tin to stock with a credit note at the invoice rate', async ({ page }) => {
  const sale = await billed('Return Stock Paints');
  expect(await onHand(sale.business)).toBe(7);
  await openInvoice(page, sale);
  await expectUsable(page);

  await page.getByRole('button', { name: 'Return items' }).click();
  const dialog = page.getByRole('dialog', { name: `Return items: ${sale.invoice.number}` });
  await dialog.getByRole('textbox', { name: 'Back to stock · Apex Ultima 1 l' }).fill('1');
  await expect(dialog.getByRole('region', { name: 'Credit note preview' })).toContainText(
    'Total₹450.00',
  );
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Issue credit note' }).click();

  await expect(page.getByRole('heading', { name: /^Credit note HYDC\// })).toBeVisible();
  await expect(page.getByText('Goods returned')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Lines' }).first()).toContainText('Total₹450.00');
  await expectUsable(page);
  expect(await onHand(sale.business)).toBe(8);

  await page.getByRole('link', { name: sale.invoice.number }).click();
  await expect(page.getByRole('table', { name: 'Returns and notes' })).toContainText(
    'Goods returned',
  );
});

test('returns a damaged tin: back in, then written off', async ({ page }) => {
  const sale = await billed('Return Damage Paints');
  await openInvoice(page, sale);

  await page.getByRole('button', { name: 'Return items' }).click();
  const dialog = page.getByRole('dialog', { name: `Return items: ${sale.invoice.number}` });
  await dialog.getByRole('textbox', { name: 'Damaged · Apex Ultima 1 l' }).fill('2');
  await expect(dialog.getByRole('region', { name: 'Credit note preview' })).toContainText(
    'Total₹900.00',
  );
  await dialog.getByRole('button', { name: 'Issue credit note' }).click();
  await expect(page.getByRole('heading', { name: /^Credit note HYDC\// })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Lines' }).first()).toContainText('Total₹900.00');
  // Damaged goods come back and are written off: the shelf is unchanged.
  expect(await onHand(sale.business)).toBe(7);
  const ledger = await call<{ items: { movementType: string; quantity: number }[] }>(
    'GET',
    '/stock/ledger',
    { token: sale.business.token },
  );
  expect(ledger.items.map((entry) => [entry.movementType, entry.quantity])).toEqual(
    expect.arrayContaining([
      ['sale_return', 2],
      ['damage', -2],
    ]),
  );
});

test('gives a discount under a scheme with a credit note', async ({ page }) => {
  const sale = await billed('Discount Paints');
  await openInvoice(page, sale);

  await page.getByRole('button', { name: 'Credit / debit note' }).click();
  const dialog = page.getByRole('dialog', {
    name: `Credit or debit note: ${sale.invoice.number}`,
  });
  await dialog.getByRole('textbox', { name: 'Value for Apex Ultima 1 l (₹)' }).fill('118');
  await dialog.getByRole('button', { name: 'Issue note' }).click();
  await expect(dialog.getByText('Name the scheme the discount comes from')).toBeVisible();
  await dialog
    .getByRole('textbox', { name: 'Scheme agreed before the sale' })
    .fill('Diwali 2026 scheme');
  await expect(dialog.getByRole('region', { name: 'Note preview' })).toContainText(
    'Taxable value₹100.00CGST₹9.00SGST₹9.00',
  );
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Issue note' }).click();

  await expect(page.getByRole('heading', { name: /^Credit note HYDC\// })).toBeVisible();
  await expect(page.getByText('Diwali 2026 scheme')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Lines' }).first()).toContainText('Total₹118.00');
  // No goods moved.
  expect(await onHand(sale.business)).toBe(7);

  await page.goto('/notes');
  await expect(page.getByRole('table', { name: 'Credit & debit notes' })).toContainText('Discount');
  await expectUsable(page);
});
