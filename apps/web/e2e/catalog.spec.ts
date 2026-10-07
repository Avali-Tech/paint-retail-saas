import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { createProduct } from './inventory-support.js';
import {
  PASSWORD,
  addMember,
  call,
  createBusiness,
  signInWithPassword,
  uniquePhone,
} from './support.js';

test('brands, a product with two pack sizes, a price change and a barcode lookup', async ({
  page,
}) => {
  const business = await createBusiness('Catalogue Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // Brands and categories first.
  await page.goto('/products/setup');
  const brands = page.getByRole('region', { name: 'Brands' });
  await brands.getByRole('textbox', { name: 'New brand' }).fill('Asian Paints');
  await brands.getByRole('button', { name: 'Add brand' }).click();
  await expect(brands.getByText('Asian Paints', { exact: true })).toBeVisible();
  const categories = page.getByRole('region', { name: 'Categories' });
  await categories.getByRole('textbox', { name: 'New category' }).fill('Emulsions');
  await categories.getByRole('button', { name: 'Add category' }).click();
  await expect(categories.getByRole('listitem').filter({ hasText: 'Emulsions' })).toBeVisible();
  await expectUsable(page);

  // A product with two pack sizes.
  await page.goto('/products');
  await expect(page.getByText('No products yet')).toBeVisible();
  await page.getByRole('link', { name: '+ Product' }).click();
  await expect(page.getByRole('heading', { name: 'New product', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Brand' }).selectOption({ label: 'Asian Paints' });
  await page
    .getByRole('combobox', { name: 'Category', exact: true })
    .selectOption({ label: 'Emulsions' });
  await page.getByRole('textbox', { name: 'Name' }).fill('Apex Ultima');
  await page.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Exterior paint' });
  const first = page.getByRole('group', { name: 'Size / pack 1' });
  await first.getByRole('textbox', { name: 'SKU' }).fill('apx-1l');
  await first.getByRole('textbox', { name: 'Size' }).fill('1');
  await first.getByRole('textbox', { name: 'MRP (₹)' }).fill('500');
  await first.getByRole('textbox', { name: 'Selling price (₹)' }).fill('450');
  await first.getByRole('textbox', { name: 'Barcodes' }).fill('8901234567890');
  await page.getByRole('button', { name: 'Add another size / pack' }).click();
  const second = page.getByRole('group', { name: 'Size / pack 2' });
  await second.getByRole('textbox', { name: 'SKU' }).fill('APX-4L');
  await second.getByRole('textbox', { name: 'Size' }).fill('4');
  await second.getByRole('textbox', { name: 'MRP (₹)' }).fill('1700');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Add product' }).click();

  await expect(page.getByRole('heading', { name: 'Apex Ultima', level: 1 })).toBeVisible();
  const variants = page.getByRole('table', { name: 'Sizes / packs' });
  await expect(variants.getByRole('row')).toHaveCount(3);
  await expect(variants.getByRole('row').nth(1)).toContainText('APX-1L');
  await expect(variants.getByRole('row').nth(1)).toContainText('₹450.00');
  await expectUsable(page);

  // A price change; the selling price may not go above the MRP.
  await page.getByRole('button', { name: 'Edit APX-1L' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit APX-1L' });
  await dialog.getByRole('textbox', { name: 'Selling price (₹)' }).fill('520');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Selling price cannot exceed the MRP')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Selling price (₹)' }).fill('425');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(variants.getByRole('row').nth(1)).toContainText('₹425.00');

  // The counter scans a barcode.
  await page.goto('/products');
  await expect(page.getByRole('table', { name: 'Products' })).toContainText('₹425.00 – ₹1,700.00');
  await page.getByRole('searchbox', { name: 'Barcode or SKU' }).fill('8901234567890');
  await page.getByRole('searchbox', { name: 'Barcode or SKU' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Apex Ultima', level: 1 })).toBeVisible();
  await page.goto('/products');
  await page.getByRole('searchbox', { name: 'Barcode or SKU' }).fill('NO-SUCH-CODE');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText('No product has the code “NO-SUCH-CODE”')).toBeVisible();
  await expectUsable(page);
});

test('a category is deactivated, leaves the product form, and comes back', async ({ page }) => {
  const business = await createBusiness('Category Paints');
  for (const name of ['Emulsions', 'Primers']) {
    await call('POST', '/categories', { token: business.token, body: { name } });
  }
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/products/setup');
  const categories = page.getByRole('region', { name: 'Categories' });
  await categories.getByRole('button', { name: 'Deactivate Primers' }).click();
  await page
    .getByRole('dialog', { name: 'Deactivate Primers?' })
    .getByRole('button', { name: 'Deactivate' })
    .click();
  await expect(
    categories.getByRole('listitem').filter({ hasText: 'Primers' }).getByText('Inactive'),
  ).toBeVisible();
  await expectUsable(page);

  // New products cannot go into it, so the form does not offer it.
  await page.goto('/products/new');
  const category = page.getByRole('combobox', { name: 'Category', exact: true });
  await expect(category.getByRole('option', { name: 'Emulsions' })).toBeAttached();
  await expect(category.getByRole('option', { name: 'Primers' })).toHaveCount(0);

  await page.goto('/products/setup');
  await categories.getByRole('button', { name: 'Activate Primers' }).click();
  await expect(categories.getByRole('button', { name: 'Deactivate Primers' })).toBeVisible();
  await page.goto('/products/new');
  await expect(category.getByRole('option', { name: 'Primers' })).toBeAttached();
});

test('counter staff see prices but cannot change them', async ({ page }) => {
  const business = await createBusiness('Counter Paints');
  await createProduct(business, { brand: 'Berger', name: 'Silk Glamour' });
  const phone = uniquePhone();
  await addMember(business, 'store_employee', {
    fullName: 'Sita Counter',
    phone,
    password: PASSWORD,
  });
  await signInWithPassword(page, phone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/products');
  await expect(page.getByRole('link', { name: 'Silk Glamour' })).toBeVisible();
  await expect(page.getByRole('link', { name: '+ Product' })).toBeHidden();
  await page.getByRole('link', { name: 'Silk Glamour' }).click();
  await expect(page.getByRole('heading', { name: 'Silk Glamour', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Sizes / packs' })).toContainText('₹450.00');
  await expect(page.getByRole('button', { name: 'Edit APX-1L' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add size / pack' })).toBeHidden();

  await page.goto('/products/new');
  await expect(page.getByText('No access')).toBeVisible();
});

test('the catalogue fits a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Catalogue Paints');
  await createProduct(business, { brand: 'Asian Paints' });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/products');
  await expect(page.getByRole('link', { name: 'Apex Ultima' })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: 'Apex Ultima' }).click();
  await expect(page.getByRole('heading', { name: 'Apex Ultima', level: 1 })).toBeVisible();
  await expectUsable(page);
  await page.goto('/products/new');
  await expect(page.getByRole('group', { name: 'Size / pack 1' })).toBeVisible();
  await expectUsable(page);
  await page.goto('/products/setup');
  await expect(page.getByText('Asian Paints', { exact: true })).toBeVisible();
  await expectUsable(page);
});

/** A paint brush in three widths: one product, a labelled single piece per width. */
const BRUSHES = [
  { sku: 'BR-1IN', label: '1 inch', barcode: '8906001200017' },
  { sku: 'BR-2IN', label: '2 inch', barcode: '8906001200024' },
  { sku: 'BR-3IN', label: '3 inch', barcode: '8906001200031' },
] as const;

test('a brush with three labelled sizes, each found by search and barcode', async ({ page }) => {
  const business = await createBusiness('Brush Hardware');
  await call('POST', '/brands', { token: business.token, body: { name: 'Asian Paints' } });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/products/new');
  await page.getByRole('combobox', { name: 'Brand' }).selectOption({ label: 'Asian Paints' });
  await page.getByRole('textbox', { name: 'Name' }).fill('Flat Paint Brush');
  await page.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Tool' });
  await page.getByRole('textbox', { name: 'HSN code' }).fill('9603');
  for (const [index, brush] of BRUSHES.entries()) {
    if (index > 0) await page.getByRole('button', { name: 'Add another size / pack' }).click();
    const group = page.getByRole('group', { name: `Size / pack ${String(index + 1)}` });
    await group.getByRole('textbox', { name: 'SKU' }).fill(brush.sku);
    await group.getByRole('textbox', { name: 'Size' }).fill('1');
    await group.getByRole('combobox', { name: 'Unit' }).selectOption('piece');
    await group.getByRole('textbox', { name: 'Label' }).fill(brush.label);
    await group.getByRole('textbox', { name: 'Barcodes' }).fill(brush.barcode);
  }
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByRole('heading', { name: 'Flat Paint Brush', level: 1 })).toBeVisible();
  const variants = page.getByRole('table', { name: 'Sizes / packs' });
  await expect(variants.getByRole('row')).toHaveCount(4);
  for (const [index, brush] of BRUSHES.entries()) {
    await expect(variants.getByRole('row').nth(index + 1)).toContainText(
      `${brush.sku}${brush.label}`,
    );
  }
  await expectUsable(page);

  // The same width again is refused.
  await page.getByRole('button', { name: 'Add size / pack' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add size / pack' });
  await dialog.getByRole('textbox', { name: 'SKU' }).fill('BR-2IN-B');
  await dialog.getByRole('textbox', { name: 'Size' }).fill('1');
  await dialog.getByRole('combobox', { name: 'Unit' }).selectOption('piece');
  await dialog.getByRole('textbox', { name: 'Label' }).fill('2 INCH');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    dialog.getByText('This product already has a variant of this size and label'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  for (const brush of BRUSHES) {
    // Search by the label finds the product; the picker-style search names the size.
    await page.goto('/products');
    await page
      .getByRole('searchbox', { name: 'Search by name, brand, SKU or label' })
      .fill(brush.label);
    await expect(page.getByRole('link', { name: 'Flat Paint Brush' })).toBeVisible();
    const search = page.getByRole('combobox', { name: 'Search' });
    await search.click();
    await search.fill(`brush ${brush.label}`);
    await expect(
      page.getByRole('option', {
        name: new RegExp(`Asian Paints Flat Paint Brush ${brush.label}`),
      }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    // The counter scans the barcode.
    await page.getByRole('searchbox', { name: 'Barcode or SKU' }).fill(brush.barcode);
    await page.getByRole('searchbox', { name: 'Barcode or SKU' }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Flat Paint Brush', level: 1 })).toBeVisible();
  }
});

test('labelled sizes fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Brush Hardware');
  await createProduct(business, {
    brand: 'Asian Paints',
    name: 'Flat Paint Brush',
    variants: BRUSHES.map(({ sku, label, barcode }) => ({
      sku,
      packSize: 1,
      unit: 'piece',
      label,
      barcodes: [barcode],
    })),
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/products');
  await expect(page.getByRole('table', { name: 'Products' })).toContainText(
    '1 inch, 2 inch, 3 inch',
  );
  await expectUsable(page);
  await page.getByRole('searchbox', { name: 'Barcode or SKU' }).fill(BRUSHES[1].barcode);
  await page.getByRole('searchbox', { name: 'Barcode or SKU' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Flat Paint Brush', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Sizes / packs' })).toContainText('2 inch');
  await expectUsable(page);
  await page.goto('/products/new');
  await expect(
    page.getByRole('group', { name: 'Size / pack 1' }).getByRole('textbox', { name: 'Label' }),
  ).toBeVisible();
  await expectUsable(page);
});
