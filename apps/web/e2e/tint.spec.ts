import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, uniquePhone, type Business } from './support.js';

// The tint record (spec §6.3, §7 Round 5 demo): a contractor's repeat order at
// Kukatpally finds the shade billed at Ameerpet (round 5a's products.isTintable,
// line tints and GET /tint-records).

const TELANGANA_GSTIN = '36AABCS1429B1ZV';
const BASE = 'Asian Paints Apex Pastel Base 4 l';

interface PaintShop {
  readonly business: Business;
  readonly contractorPhone: string;
}

/** Ameerpet and Kukatpally, a tintable pastel base and a hinge in stock, and a contractor. */
async function paintShop(name: string): Promise<PaintShop> {
  const business = await createBusiness(name, [
    ['AMP', 'Ameerpet'],
    ['KPH', 'Kukatpally'],
  ]);
  const { token } = business;
  await call('PUT', '/gst-registrations/business', { token, body: { legalName: `${name} LLP` } });
  for (const store of business.stores) {
    await call('PUT', `/gst-registrations/stores/${store.id}`, {
      token,
      body: { registrationType: 'regular', stateCode: '36', gstin: TELANGANA_GSTIN },
    });
  }
  const { categories } = await call<{ categories: { id: string; key: string | null }[] }>(
    'GET',
    '/tax-categories/options',
    { token },
  );
  const category = (key: string) => categories.find((option) => option.key === key)?.id;
  const brand = await call<{ id: string }>('POST', '/brands', {
    token,
    body: { name: 'Asian Paints' },
  });
  const base = await call<{ variants: { id: string }[] }>('POST', '/products', {
    token,
    body: {
      brandId: brand.id,
      name: 'Apex Pastel Base',
      type: 'exterior_paint',
      hsnCode: '3209',
      taxCategoryId: category('paints'),
      isTintable: true,
      variants: [
        { sku: 'APB-4L', packSize: 4, unit: 'l', sellingPricePaise: 2_000_00, barcodes: [] },
      ],
    },
  });
  const hinge = await call<{ variants: { id: string }[] }>('POST', '/products', {
    token,
    body: {
      brandId: brand.id,
      name: 'Hinge',
      type: 'tool',
      hsnCode: '8302',
      taxCategoryId: category('brushes_rollers'),
      variants: [
        {
          sku: 'HNG-4',
          packSize: 1,
          unit: 'piece',
          label: '4 inch',
          sellingPricePaise: 500_00,
          barcodes: [],
        },
      ],
    },
  });
  for (const store of business.stores) {
    await openingStock(business, store.id, [
      { variantId: String(base.variants[0]?.id), quantity: 20, unitCostPaise: 1_500_00 },
      { variantId: String(hinge.variants[0]?.id), quantity: 20, unitCostPaise: 300_00 },
    ]);
  }
  // Ameerpet's register is open for the day's cash (spec §5.5).
  await call('POST', '/registers/C1/open', {
    token,
    body: { storeId: business.stores[0]?.id, openingFloatPaise: 200_000 },
  });
  const contractorPhone = uniquePhone();
  await call('POST', '/parties', {
    token,
    body: {
      displayName: 'Deccan Contractors',
      phone: contractorPhone,
      roles: ['customer', 'contractor'],
    },
  });
  return { business, contractorPhone };
}

async function signIn(page: Page, business: Business) {
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

test('a contractor’s repeat order at Kukatpally finds the shade billed at Ameerpet', async ({
  page,
}) => {
  const { business, contractorPhone } = await paintShop('Shade Paints');
  await signIn(page, business);

  // Ameerpet: the contractor's bill, the base tinted to X 132.
  await page.goto('/pos');
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'AMP · Ameerpet' });
  const scan = page.getByRole('combobox', { name: 'Scan or search' });
  await scan.fill('2*APB-4L');
  await scan.press('Enter');
  await page.getByRole('button', { name: 'Find customer' }).click();
  await page.getByRole('textbox', { name: 'Customer mobile' }).fill(contractorPhone.slice(3));
  await page.getByRole('textbox', { name: 'Customer mobile' }).press('Enter');
  await expect(page.getByText(/Deccan Contractors ·/)).toBeVisible();
  await page.getByRole('button', { name: `Tint ${BASE}` }).click();
  const dialog = page.getByRole('dialog', { name: `Tint ${BASE}` });
  await dialog.getByRole('textbox', { name: /^Shade code/ }).fill('X 132');
  await dialog.getByRole('textbox', { name: /^Shade name/ }).fill('Ivory Mist');
  await dialog.getByRole('textbox', { name: /^Machine/ }).fill('Counter 1');
  await dialog.getByRole('textbox', { name: /^Tinting charge/ }).fill('50');
  await dialog.getByRole('textbox', { name: 'Colorant 1' }).fill('XY');
  await dialog.getByRole('textbox', { name: 'Amount 1' }).fill('12.5');
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Apply tint' }).click();
  await expect(page.getByText('Shade X 132 · Ivory Mist · tinting ₹50.00')).toBeVisible();
  await expect(page.getByText('Bill saved')).toBeVisible();
  await page.keyboard.press('F8');
  await page
    .getByRole('dialog', { name: 'Payment' })
    .getByRole('button', { name: 'Issue bill' })
    .click();
  await expect(page.getByRole('dialog', { name: /^Bill AMP\// })).toBeVisible();

  // Kukatpally: a new order for the same contractor picks the same shade.
  await page.goto('/sales-orders/new');
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'KPH · Kukatpally' });
  await page.getByRole('button', { name: 'Choose Bill to' }).click();
  await page.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill('Deccan');
  await page.getByRole('button', { name: 'Choose Deccan Contractors' }).click();
  const orderScan = page.getByRole('combobox', { name: 'Scan or search' });
  await orderScan.fill('2*APB-4L');
  await orderScan.press('Enter');
  await page.getByRole('button', { name: `Tint ${BASE}` }).click();
  const repeat = page.getByRole('dialog', { name: `Tint ${BASE}` });
  const shades = repeat.getByRole('region', { name: 'Same shade as last time' });
  await expect(shades).toContainText('X 132 · Ivory Mist');
  await expect(shades).toContainText(/Deccan Contractors · Ameerpet · .* · Invoice AMP\//);
  await shades.getByRole('button', { name: 'Use X 132' }).click();
  await expect(repeat.getByRole('textbox', { name: /^Machine/ })).toHaveValue('Counter 1');
  await repeat.getByRole('button', { name: 'Apply tint' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: /^Sales order SO-/, level: 1 })).toBeVisible();

  const history = await call<{ items: { store: { name: string }; shadeCode: string }[] }>(
    'GET',
    '/tint-records?shadeCode=X%20132',
    { token: business.token },
  );
  expect(history.items.map((record) => record.store.name).sort()).toEqual([
    'Ameerpet',
    'Kukatpally',
  ]);
});

test('the tint panel shows only for tintable products, and fits a phone @phone', async ({
  page,
}) => {
  const { business } = await paintShop('Hinge Paints');
  await signIn(page, business);
  await page.goto('/pos');
  const scan = page.getByRole('combobox', { name: 'Scan or search' });
  await scan.fill('HNG-4');
  await scan.press('Enter');
  await scan.fill('APB-4L');
  await scan.press('Enter');
  await expect(page.getByRole('button', { name: `Tint ${BASE}` })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tint Asian Paints Hinge/ })).toHaveCount(0);
  await page.getByRole('button', { name: `Tint ${BASE}` }).click();
  await expect(page.getByRole('dialog', { name: `Tint ${BASE}` })).toBeVisible();
  await expectUsable(page);
});
