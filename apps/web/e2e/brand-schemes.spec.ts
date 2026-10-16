import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { createProduct, createSupplier } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

// Brand schemes (P2-M33): a scheme entered with its slabs, its progress from a GRN of
// the brand, and a credit note from the brand recorded against what it earned.

/** An India date `days` from today, as YYYY-MM-DD. */
const indiaDay = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });

/** A brand with a 10 L pack, and a GRN of 10 at ₹4,000 plus 1 free, received today. */
async function brandBought(business: Business, brand: string) {
  const product = await createProduct(business, {
    brand,
    name: 'Ultima',
    variants: [{ sku: 'ULT-10L', packSize: 10 }],
  });
  const variantId = product.variants[0]?.id;
  const supplier = await createSupplier(business, `${brand} Distributors`);
  await call('POST', '/goods-receipts', {
    token: business.token,
    body: {
      storeId: business.stores[0]?.id,
      supplierId: supplier,
      supplierInvoiceNumber: 'INV-1',
      lines: [{ variantId, quantity: 10, freeQuantity: 1, unitCostPaise: 4_000_00 }],
    },
  });
  const brands = await call<{ id: string; name: string }[]>('GET', '/brands', {
    token: business.token,
  });
  return String(brands.find((row) => row.name === brand)?.id);
}

test('a scheme entered with slabs, its progress from a GRN, and a credit note from the brand', async ({
  page,
}) => {
  test.slow();
  const business = await createBusiness('Scheme Paints');
  await brandBought(business, 'Apex Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/brand-schemes');
  await expect(page.getByText('No brand scheme yet.')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: 'New scheme' }).click();
  await expect(page.getByRole('heading', { name: 'New brand scheme' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Brand' }).selectOption({ label: 'Apex Paints' });
  await page.getByRole('textbox', { name: 'Scheme name' }).fill('Festive slab');
  await page.getByLabel('From', { exact: true }).fill(indiaDay(-10));
  await page.getByLabel('To', { exact: true }).fill(indiaDay(19));
  await page.getByRole('textbox', { name: 'Slab 1 target (₹)' }).fill('30000');
  await page.getByRole('textbox', { name: 'Slab 1 benefit 1: rebate (%)' }).fill('1');
  await page.getByRole('button', { name: 'Add slab' }).click();
  await page.getByRole('textbox', { name: 'Slab 2 target (₹)' }).fill('60000');
  await page.getByRole('textbox', { name: 'Slab 2 benefit 1: rebate (%)' }).fill('2');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(
    page.getByRole('heading', { name: 'Apex Paints · Festive slab', level: 1 }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('The scheme now counts')).toBeVisible();
  // ₹40,000 bought: slab 1 reached, ₹20,000 to slab 2 over the 19 days left.
  await expect(page.getByText('₹20,000.00 to slab 2, ₹1,052.64 a day needed')).toBeVisible();
  await expect(page.getByRole('table', { name: 'GRNs counted' })).toContainText(
    'ULT-10L10 + 1 free₹40,000.00110 L',
  );
  await expectUsable(page);

  // The brand's credit note for half of the ₹400 earned.
  await page.getByRole('button', { name: 'Record what came' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record what came' });
  await dialog.getByRole('textbox', { name: 'Amount (₹)' }).fill('200');
  await dialog
    .getByRole('textbox', { name: 'Brand’s reference (credit note or letter)' })
    .fill('CN-501');
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Recorded', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'What the brand issued' })).toContainText(
    '₹200.00 · Credit noteCN-501',
  );
  await expect(page.getByRole('table', { name: 'Benefits expected and received' })).toContainText(
    'Credit notes and payments₹400.00₹200.00₹200.00',
  );

  await page.goto('/brand-schemes');
  await expect(page.getByRole('progressbar', { name: '₹40,000.00 of ₹60,000.00' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Brand schemes' })).toContainText(
    'Bought ₹40,000.00Earned ₹400.00Still owed ₹200.00',
  );
  await expectUsable(page);
  await page.getByRole('link', { name: 'Scheme claims' }).click();
  await expect(page.getByRole('table', { name: 'Schemes' })).toContainText('Festive slab');
  await expectUsable(page);
  await page.getByRole('link', { name: 'Price-hike planner' }).click();
  await page.getByRole('combobox', { name: 'Brand' }).selectOption({ label: 'Apex Paints' });
  await page.getByRole('textbox', { name: 'Price rise (%)' }).fill('5');
  await page.getByRole('button', { name: 'Plan' }).click();
  await expect(page.getByRole('table', { name: 'Stock-up plan' })).toContainText('ULT-10L');
  await expectUsable(page);
});

test('brand schemes on a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Scheme Paints');
  const brandId = await brandBought(business, 'Berger');
  const scheme = await call<{ id: string }>('POST', '/brand-schemes', {
    token: business.token,
    body: {
      brandId,
      name: 'Litres club',
      startsOn: indiaDay(-5),
      endsOn: indiaDay(24),
      measure: 'litres',
      slabs: [
        { target: 200_000, benefits: [{ kind: 'per_litre', paisePerLitre: 300 }] },
        { target: 400_000, benefits: [{ kind: 'points', label: 'Goa trip', points: 1 }] },
      ],
    },
  });
  await call('POST', `/brand-schemes/${scheme.id}/activate`, { token: business.token });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Brand schemes' })).toBeVisible();

  await page.goto('/brand-schemes');
  await expect(page.getByText('90 L to slab 1, 3.75 L a day needed')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: 'Berger · Litres club' }).click();
  await expect(page.getByRole('heading', { name: 'Berger · Litres club', level: 1 })).toBeVisible();
  await expectUsable(page);
  await page.goto(`/brand-schemes/${scheme.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Slab 1 target (litres)' })).toHaveValue('200');
  await expectUsable(page);
});
