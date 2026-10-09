import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

// The day end and the books (spec §5.5, §6.1; round 4c): a register closes with a
// ₹20 variance and a Z-report, a receipt prints as a PDF, and the month goes to Tally,
// refunds and bounced cheques included.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Shop {
  readonly business: Business;
  readonly storeId: string;
  /** A 4-inch paint brush: hardware at 18%, ₹118 a piece. */
  readonly brush: string;
  readonly modes: Readonly<Record<string, string>>;
}

/** A GST-registered store selling a brush (hardware, like paint, is just an item). */
async function shop(name: string): Promise<Shop> {
  const business = await createBusiness(name, [['AMP', 'Ameerpet']]);
  const { token } = business;
  const storeId = String(business.stores[0]?.id);
  await call('PUT', '/gst-registrations/business', { token, body: { legalName: `${name} LLP` } });
  await call('PUT', `/gst-registrations/stores/${storeId}`, {
    token,
    body: { registrationType: 'regular', stateCode: '36', gstin: TELANGANA_GSTIN },
  });
  const { categories } = await call<{ categories: { id: string; key: string | null }[] }>(
    'GET',
    '/tax-categories/options',
    { token },
  );
  const brand = await call<{ id: string }>('POST', '/brands', { token, body: { name: 'Asian' } });
  const product = await call<{ variants: { id: string }[] }>('POST', '/products', {
    token,
    body: {
      brandId: brand.id,
      name: 'Paint Brush',
      type: 'tool',
      hsnCode: '9603',
      taxCategoryId: categories.find((option) => option.key === 'brushes_rollers')?.id,
      variants: [
        { sku: 'BR-4', packSize: 1, unit: 'piece', label: '4 inch', sellingPricePaise: 11_800 },
      ],
    },
  });
  const brush = String(product.variants[0]?.id);
  await openingStock(business, storeId, [{ variantId: brush, quantity: 50, unitCostPaise: 6_000 }]);
  const modes = await call<{ id: string; kind: string }[]>('GET', '/payment-modes', { token });
  return {
    business,
    storeId,
    brush,
    modes: Object.fromEntries(modes.map((mode) => [mode.kind, mode.id])),
  };
}

/** Issues a bill for `quantity` brushes, paid (or not) as given. */
async function bill(
  { business, storeId, brush }: Shop,
  quantity: number,
  issue: object,
  partyId?: string,
) {
  const { token } = business;
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: { storeId, partyId, lines: [{ variantId: brush, quantity }] },
  });
  return call<{ id: string; totalPaise: number; issuedOn: string }>(
    'POST',
    `/invoices/${draft.id}/issue`,
    {
      token,
      body: issue,
    },
  );
}

async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    const counted = window as unknown as { printed: number };
    counted.printed = 0;
    window.print = () => {
      counted.printed += 1;
    };
  });
}

test('a branch opens its register, takes cash and closes ₹20 short with a Z-report', async ({
  page,
}) => {
  const ameerpet = await shop('Day End Paints');
  await stubPrint(page);
  await signInWithPassword(page, ameerpet.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await page.getByRole('link', { name: 'Day end' }).first().click();
  await expect(page.getByRole('heading', { name: 'Day end', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: 'Opening float (₹)' }).fill('2000');
  await page.getByRole('button', { name: 'Open register' }).click();
  await expect(page.getByRole('heading', { name: 'Register COUNTER-1', level: 1 })).toBeVisible();

  // A walk-in buys a brush for cash at the counter.
  await bill(ameerpet, 1, { payments: [{ modeId: ameerpet.modes.cash, amountPaise: 11_800 }] });
  await page.reload();
  const drawer = page.getByRole('region', { name: 'Cash in the drawer' });
  await expect(drawer).toContainText('Cash received₹118.00');
  await expect(drawer).toContainText('Expected cash₹2,118.00');
  await expectUsable(page);

  const close = page.getByRole('form', { name: 'Count the cash and close' });
  for (const [note, count] of [
    ['₹500.00', '4'],
    ['₹50.00', '1'],
    ['₹20.00', '2'],
    ['₹5.00', '1'],
    ['₹2.00', '1'],
    ['₹1.00', '1'],
  ] as const) {
    await close.getByRole('textbox', { name: `Number of ${note}` }).fill(count);
  }
  await expect(close.getByLabel('The count')).toContainText(
    'Counted₹2,098.00Expected cash₹2,118.00VarianceShort by ₹20.00',
  );
  await close.getByRole('button', { name: 'Close register' }).click();

  const report = page.getByRole('article', { name: 'Z-report' });
  await expect(report).toContainText('AMP · Ameerpet');
  await expect(report).toContainText('Counted₹2,098.00VarianceShort by ₹20.00');
  await expect(report).toContainText('₹500.00 × 4₹2,000.00');
  await page.getByRole('button', { name: 'Print Z-report' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { printed: number }).printed))
    .toBe(1);
  await expectUsable(page);

  await page.getByRole('link', { name: 'Day end' }).first().click();
  await expect(page.getByRole('table', { name: 'Sessions' })).toContainText('-₹20.00');
});

test('a receipt prints as a PDF, and the month goes to Tally once its bank is mapped', async ({
  page,
}) => {
  test.slow();
  const books = await shop('Tally Paints');
  const { token } = books.business;
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Deccan Contractors', roles: ['customer'] },
  });
  const invoice = await bill(books, 2, {}, party.id);
  await bill(books, 1, { payments: [{ modeId: books.modes.upi, amountPaise: 11_800 }] });
  const receipt = await call<{ number: string }>('POST', '/payments', {
    token,
    body: {
      storeId: books.storeId,
      partyId: party.id,
      modeId: books.modes.bank_transfer,
      amountPaise: invoice.totalPaise,
      reference: 'UTR778899',
      allocations: [{ documentId: invoice.id, amountPaise: invoice.totalPaise }],
    },
  });
  // An advance partly paid back, and a cheque the bank returned.
  const advance = await call<{ id: string }>('POST', '/payments', {
    token,
    body: {
      storeId: books.storeId,
      partyId: party.id,
      modeId: books.modes.upi,
      amountPaise: 5_000,
      reference: 'UTR112233',
      allocations: [],
    },
  });
  await call('POST', `/payments/${advance.id}/refund`, {
    token,
    body: { modeId: books.modes.upi, amountPaise: 2_000, reference: 'UTR445566' },
  });
  const cheque = await call<{ id: string }>('POST', '/payments', {
    token,
    body: {
      storeId: books.storeId,
      partyId: party.id,
      modeId: books.modes.cheque,
      amountPaise: 3_000,
      reference: '004512',
      chequeDate: invoice.issuedOn,
      allocations: [],
    },
  });
  await call('POST', `/payments/${cheque.id}/bounce`, { token, body: { reason: 'Funds' } });

  await signInWithPassword(page, books.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await page.getByRole('link', { name: 'Payments' }).first().click();
  const payments = page.getByRole('table', { name: 'Payments' });
  await expect(payments).toContainText(receipt.number);
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: `Receipt PDF ${receipt.number}` }).click(),
  ]);
  expect(pdf.suggestedFilename()).toBe(`${receipt.number}.pdf`);
  expect(
    readFileSync(await pdf.path())
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');

  await page.getByRole('link', { name: 'Tally export' }).first().click();
  const counts = page.getByLabel('Vouchers in the period');
  await expect(counts).toContainText('Sales2Credit notes0Debit notes0Receipts4');
  await expect(
    page.getByText(
      'With the receipts go 1 refund, each a Payment voucher, and 1 bounced cheque, each reversed by a Journal voucher on the day it bounced.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/No Tally ledger is mapped for payment mode "Bank transfer"/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export' })).toBeDisabled();
  await expectUsable(page);

  await page.getByRole('link', { name: 'Map ledgers' }).click();
  const form = page.getByRole('form', { name: 'Add a mapping' });
  await form.getByRole('combobox', { name: 'For' }).selectOption('payment_mode');
  await form.getByRole('combobox', { name: 'Kind of payment' }).selectOption('bank_transfer');
  await form.getByRole('textbox', { name: 'Tally ledger' }).fill('HDFC Bank');
  await form.getByRole('combobox', { name: /^Group/ }).selectOption('Bank Accounts');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('table', { name: 'Ledger mapping' })).toContainText(
    'Payment modeBank transferHDFC BankBank Accounts',
  );
  await expectUsable(page);

  await page.getByRole('link', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled();
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(file.suggestedFilename()).toMatch(/^tally-\d{4}-\d{2}-01-to-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = readFileSync(await file.path()).toString('utf8');
  expect(zip).toContain('1-masters.xml');
  expect(zip).toContain('HDFC Bank');
  expect(zip).toContain('Deccan Contractors');
  expect(zip).toContain('Cash Sales');
  expect(zip).toContain('VCHTYPE="Payment"');
  expect(zip).toContain('VCHTYPE="Journal"');
  expect(zip).toContain(`REMOTEID="paint-${cheque.id}-bounce"`);
  await expect(page.getByRole('table', { name: 'Past exports' })).toContainText(
    'Sales, Credit notes, Debit notes, Receipts8',
  );
});

test('the books are reconciled by hand from the accounting screens', async ({ page }) => {
  const books = await shop('Balanced Paints');
  await bill(books, 2, { payments: [{ modeId: books.modes.upi, amountPaise: 23_600 }] });

  await signInWithPassword(page, books.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await page.getByRole('link', { name: 'Tally export' }).first().click();
  await page.getByRole('link', { name: 'Reconciliation' }).click();
  await expect(page.getByRole('heading', { name: 'Reconciliation', level: 1 })).toBeVisible();
  await expect(page.getByText(/^Not checked yet/)).toBeVisible();
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(
    page.getByText('Everything agrees: stock, party balances and payments match their entries.'),
  ).toBeVisible();
  await expect(page.getByLabel('About this check')).toContainText('by hand');
  await expectUsable(page);
});
