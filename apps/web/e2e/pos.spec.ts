import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import {
  PASSWORD,
  addMember,
  call,
  createBusiness,
  signInWithPassword,
  uniquePhone,
  type Business,
} from './support.js';

// The counter sale (spec §5.2): a cashier scans, searches, splits the payment and
// bills at the counter, with the store's register open for the cash.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';
const APEX_BARCODE = '8901000000019';

interface Counter {
  readonly business: Business;
  readonly cashierPhone: string;
}

/** A GST-registered store with a paint, a putty and a roller in stock, and its cashier. */
async function counter(name: string): Promise<Counter> {
  const business = await createBusiness(name, [['AMP', 'Ameerpet']]);
  const { token } = business;
  const [store] = business.stores;
  const storeId = String(store?.id);
  await call('PUT', '/gst-registrations/business', {
    token,
    body: { legalName: `${name} LLP` },
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
  const category = (key: string) => categories.find((option) => option.key === key)?.id;
  const brand = await call<{ id: string }>('POST', '/brands', {
    token,
    body: { name: 'Asian Paints' },
  });
  const variants: string[] = [];
  for (const product of [
    {
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '3209',
      taxCategoryId: category('paints'),
      variants: [
        {
          sku: 'APX-20L',
          packSize: 20,
          unit: 'l',
          sellingPricePaise: 1_045_000,
          barcodes: [APEX_BARCODE],
        },
      ],
    },
    {
      name: 'Trucare Wall Putty',
      type: 'putty',
      hsnCode: '3214',
      taxCategoryId: category('putty'),
      variants: [
        { sku: 'TWP-20KG', packSize: 20, unit: 'kg', sellingPricePaise: 112_000, barcodes: [] },
      ],
    },
    {
      name: 'Paint Roller',
      type: 'tool',
      hsnCode: '9603',
      taxCategoryId: category('brushes_rollers'),
      variants: [
        {
          sku: 'ROL-9',
          packSize: 1,
          unit: 'piece',
          label: '9 inch',
          sellingPricePaise: 26_000,
          barcodes: [],
        },
      ],
    },
  ]) {
    const created = await call<{ variants: { id: string }[] }>('POST', '/products', {
      token,
      body: { brandId: brand.id, ...product },
    });
    variants.push(...created.variants.map((variant) => variant.id));
  }
  await openingStock(
    business,
    storeId,
    variants.map((variantId) => ({ variantId, quantity: 10, unitCostPaise: 10_000 })),
  );
  const cashierPhone = uniquePhone();
  await addMember(business, 'store_employee', {
    fullName: 'Ravi Cashier',
    phone: cashierPhone,
    password: PASSWORD,
  });
  // The day's register is open, as it is before the first customer (spec §5.5).
  await call('POST', '/registers/C1/open', {
    token,
    body: { storeId, openingFloatPaise: 200_000 },
  });
  return { business, cashierPhone };
}

/** The browser's print dialog, counted instead of opened. */
async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    const counted = window as unknown as { printed: number };
    counted.printed = 0;
    window.print = () => {
      counted.printed += 1;
    };
  });
}

const printed = (page: Page) =>
  page.evaluate(() => (window as unknown as { printed: number }).printed);

async function openCounter(page: Page, { cashierPhone }: Counter) {
  await stubPrint(page);
  await signInWithPassword(page, cashierPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await page.getByRole('link', { name: 'Counter sale' }).first().click();
  const scan = page.getByRole('combobox', { name: 'Scan or search' });
  await expect(scan).toBeFocused();
  return scan;
}

test('a 3-item walk-in sale is billed and printed in under 60 seconds', async ({ page }) => {
  // Setting up the business and signing in take most of the time; the sale is timed.
  test.slow();
  const shop = await counter('Counter Paints');
  const scan = await openCounter(page, shop);
  const bill = page.getByRole('list', { name: 'Bill' });
  await expect(page.getByText('Register open · C1')).toBeVisible();

  // Step 1: the screen is open on an empty bill with the focus in the scan box.
  const started = Date.now();
  // Step 2: a barcode scan, "2*" and an SKU, and a few letters of a name.
  await page.keyboard.type(APEX_BARCODE);
  await page.keyboard.press('Enter');
  await expect(bill.getByRole('listitem')).toHaveCount(1);
  await page.keyboard.type('2*TWP-20KG');
  await page.keyboard.press('Enter');
  await expect(bill.getByRole('listitem')).toHaveCount(2);
  await page.keyboard.type('roll');
  await page.keyboard.press('Enter');
  await expect(bill.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByTestId('pos-total')).toHaveText('₹12,950.00');
  // Step 3 (walk-in) skipped. Step 4: F8 pays, cash pre-filled; a smaller cash amount
  // moves the rest to UPI. Step 5: Enter issues and prints.
  await page.keyboard.press('F8');
  const pay = page.getByRole('dialog', { name: 'Payment' });
  await expect(pay.getByRole('textbox', { name: 'Amount of payment 1' })).toHaveValue('12950.00');
  await page.keyboard.type('2000');
  await expect(pay.getByRole('textbox', { name: 'Amount of payment 2' })).toHaveValue('10950.00');
  await page.keyboard.press('Enter');
  const issued = page.getByRole('dialog', { name: /^Bill AMP\/\d{2}-\d{2}\/000001 issued$/ });
  await expect(issued).toBeVisible();
  await expect.poll(() => printed(page)).toBe(1);
  // New sale.
  await page.keyboard.press('Enter');
  await expect(page.getByText('Scan or search a product to start the bill.')).toBeVisible();
  await expect(scan).toBeFocused();
  const seconds = (Date.now() - started) / 1000;
  test.info().annotations.push({ type: 'sale seconds', description: seconds.toFixed(1) });
  expect(seconds).toBeLessThan(60);

  const invoices = await call<{ items: { number: string; totalPaise: number; status: string }[] }>(
    'GET',
    '/invoices?status=issued',
    { token: shop.business.token },
  );
  expect(invoices.items).toEqual([
    expect.objectContaining({ totalPaise: 1_295_000, status: 'issued' }),
  ]);
  const payments = await call<{ items: { modeKind: string; amountPaise: number }[] }>(
    'GET',
    '/payments',
    { token: shop.business.token },
  );
  expect(payments.items.map((payment) => [payment.modeKind, payment.amountPaise]).sort()).toEqual([
    ['cash', 200_000],
    ['upi', 1_095_000],
  ]);
});

test('the counter prints the bank details and terms the owner set', async ({ page }) => {
  const shop = await counter('Bank Print Paints');
  await stubPrint(page);
  await signInWithPassword(page, shop.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();

  // Settings, Invoice print: the bank details and terms the A4 invoice prints.
  await page.goto('/settings/invoice-print');
  await expect(page.getByRole('heading', { name: 'Invoice print', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: 'Bank and branch' }).fill('HDFC Bank, Ameerpet');
  await page.getByRole('textbox', { name: 'Account name' }).fill('Bank Print Paints LLP');
  await page.getByRole('textbox', { name: 'Account number' }).fill('50100123456789');
  await page.getByRole('textbox', { name: 'IFSC' }).fill('hdfc0001234');
  await page.getByRole('textbox', { name: /^UPI ID/ }).fill('bankprint@hdfc');
  await page.getByRole('textbox', { name: /^Terms/ }).fill('No returns on tinted paint.');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Invoice print settings saved')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'IFSC' })).toHaveValue('HDFC0001234');

  await page.goto('/pos');
  const scan = page.getByRole('combobox', { name: 'Scan or search' });
  await scan.fill(APEX_BARCODE);
  await scan.press('Enter');
  await page.getByRole('button', { name: /^Pay ₹10,450\.00/ }).click();
  await page
    .getByRole('dialog', { name: 'Payment' })
    .getByRole('button', { name: 'Issue bill' })
    .click();
  const issued = page.getByRole('dialog', { name: /^Bill AMP\/\d{2}-\d{2}\/000001 issued$/ });
  await expect(issued).toBeVisible();
  await issued.getByRole('button', { name: 'Print A4' }).click();
  await expect.poll(() => printed(page)).toBe(2);
  const a4 = page.getByTestId('print-layer');
  await expect(a4).toHaveAttribute('data-format', 'a4');
  await expect(a4).toContainText('HDFC Bank, Ameerpet');
  await expect(a4).toContainText('IFSC HDFC0001234');
  await expect(a4).toContainText('UPI: bankprint@hdfc');
  await expect(a4).toContainText('No returns on tinted paint.');
});

test('a bill is held with F4, resumed from the tray, and the counter passes axe', async ({
  page,
}) => {
  const shop = await counter('Held Paints');
  const scan = await openCounter(page, shop);
  await expectUsable(page);
  await scan.fill('TWP-20KG');
  await scan.press('Enter');
  const line = page.getByRole('listitem', { name: 'Asian Paints Trucare Wall Putty 20 kg' });
  await expect(line).toBeVisible();
  await page.getByRole('textbox', { name: 'Customer mobile' }).fill('9000000000');
  await page.getByRole('button', { name: 'Find customer' }).click();
  await expect(
    page.getByText('No customer with this mobile; the bill stays walk-in.'),
  ).toBeVisible();
  await expect(page.getByText('Bill saved')).toBeVisible();
  await expectUsable(page);

  await page.keyboard.press('F4');
  await expect(page.getByText('Bill held')).toBeVisible();
  await expect(line).toBeHidden();
  await page.getByRole('button', { name: 'Held (1)' }).click();
  const tray = page.getByRole('dialog', { name: 'Held bills' });
  await expect(tray).toContainText('₹1,120.00');
  await expectUsable(page);
  await tray.getByRole('button', { name: 'Resume the bill of Walk-in customer' }).click();
  await expect(line).toBeVisible();

  // A reload keeps the bill on the counter.
  await page.reload();
  await expect(line).toBeVisible();
  await page.getByRole('button', { name: /^Pay ₹1,120\.00/ }).click();
  await expect(page.getByRole('dialog', { name: 'Payment' })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Issue bill' }).click();
  await expect(page.getByRole('dialog', { name: /issued$/ })).toBeVisible();
  await expectUsable(page);
});

test('the counter fits a phone @phone', async ({ page }) => {
  const shop = await counter('Phone Counter Paints');
  await stubPrint(page);
  await signInWithPassword(page, shop.cashierPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await page.goto('/pos');
  const scan = page.getByRole('combobox', { name: 'Scan or search' });
  await expect(scan).toBeVisible();
  await expectUsable(page);
  await scan.fill('roll');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Bill' }).getByRole('listitem')).toHaveCount(1);
  await scan.fill(APEX_BARCODE);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Bill' }).getByRole('listitem')).toHaveCount(2);
  await page.getByRole('textbox', { name: 'Buyer GSTIN (B2B)' }).fill('37AABCS1429B1ZT');
  await expect(page.getByText('IGST 18%')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: /^Pay / }).click();
  await expect(page.getByRole('dialog', { name: 'Payment' })).toBeVisible();
  await expectUsable(page);
});
