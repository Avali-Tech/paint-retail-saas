import { devices, expect, test, type Page } from '@playwright/test';
import { hi } from '../src/i18n/hi.js';
import { te } from '../src/i18n/te.js';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, uniquePhone, type Business } from './support.js';

// UPI payment links (roadmap P2-M32, MVP 3 round 4): a link sent from the collections
// worklist or an invoice, paid on the log gateway's test page, whose signed webhook
// records and allocates the payment with no one entering it; a replay changes nothing.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Shop {
  readonly business: Business;
  readonly contractor: string;
  readonly invoice: { readonly id: string; readonly number: string };
}

/** A registered store and a contractor with one ₹236 bill due in 2020 (always overdue). */
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
  const contractor = await call<{ id: string }>('POST', '/parties', {
    token,
    body: {
      displayName: 'Deccan Contractors',
      phone: uniquePhone(),
      roles: ['customer', 'contractor'],
      homeStoreId: storeId,
    },
  });
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: {
      storeId,
      partyId: contractor.id,
      dueOn: '2020-01-01',
      lines: [{ variantId: brush, quantity: 2 }],
    },
  });
  const issued = await call<{ id: string; number: string }>('POST', `/invoices/${draft.id}/issue`, {
    token,
    body: {},
  });
  return { business, contractor: contractor.id, invoice: issued };
}

async function signIn(page: Page, books: Shop) {
  await signInWithPassword(page, books.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
}

/** Makes a link in the open dialog and answers its address. */
async function makeLink(page: Page, amount?: string): Promise<string> {
  const dialog = page.getByRole('dialog', { name: 'Send a UPI payment link' });
  if (amount !== undefined) await dialog.getByLabel(/Amount/).fill(amount);
  await dialog.getByRole('button', { name: 'Make link' }).click();
  const result = page.getByRole('dialog', { name: /^Payment link PL-\d{6}$/ });
  await expect(result).toBeVisible();
  const url = (await result.locator('code').textContent()) ?? '';
  expect(url).toMatch(/\/pay\/plink_log_[\w-]{22}$/);
  await result.getByRole('button', { name: 'Done' }).click();
  return url;
}

test('a link sent from the worklist is paid by UPI and recorded with no manual entry; a replay changes nothing', async ({
  page,
}) => {
  const books = await shop('Payment Link Paints');
  await signIn(page, books);
  await page.goto('/collections');
  await page.getByLabel('Whose customers').selectOption('all');
  await page.getByRole('button', { name: 'Send a payment link to Deccan Contractors' }).click();
  const url = await makeLink(page);

  // The customer opens the link: the log gateway's test page.
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Test payment page' })).toBeVisible();
  await expect(page.getByText('Deccan Contractors')).toBeVisible();
  await expectUsable(page);
  await expect(page.getByLabel('Amount to pay (₹)')).toHaveValue('236.00');
  await page.getByRole('button', { name: 'Pay by UPI (test)' }).click();
  await expect(page.getByText('Paid: the payment is recorded and allocated.')).toBeVisible();
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();

  // The gateway sends the same webhook again.
  await page.getByRole('button', { name: 'Send the same payment again' }).click();
  await expect(
    page.getByText('Sent again: it was already recorded, so nothing changed.'),
  ).toBeVisible();

  // Recorded once, allocated to the bill: the customer owes nothing.
  const ledger = await call<{ balancePaise: number; advancePaise: number }>(
    'GET',
    `/parties/${books.contractor}/ledger`,
    { token: books.business.token },
  );
  expect(ledger).toMatchObject({ balancePaise: 0, advancePaise: 0 });
  await page.goto('/payments?modeKind=upi_link');
  const table = page.getByRole('table', { name: 'Payments' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('UPI link')).toBeVisible();
  await page.goto('/payment-links');
  await expect(
    page.getByRole('table', { name: 'Payment links' }).locator('tbody').getByText('Paid'),
  ).toBeVisible();
});

test('a part payment on an invoice’s link leaves it open, part paid', async ({ page }) => {
  const books = await shop('Part Payment Paints');
  await signIn(page, books);
  await page.goto(`/invoices/${books.invoice.id}`);
  const panel = page.getByRole('region', { name: 'UPI payment links' });
  await expect(panel.getByText('No payment link has been sent yet.')).toBeVisible();
  await panel.getByRole('button', { name: 'Send a payment link to Deccan Contractors' }).click();
  await expect(page.getByText(`For invoice ${books.invoice.number}`)).toBeVisible();
  const url = await makeLink(page);

  await page.goto(url);
  await page.getByLabel('Amount to pay (₹)').fill('100');
  await page.getByRole('button', { name: 'Pay by UPI (test)' }).click();
  await expect(page.getByText('Paid: the payment is recorded and allocated.')).toBeVisible();

  await page.goto(`/invoices/${books.invoice.id}`);
  await expect(panel.getByText('Part paid')).toBeVisible();
  await expect(panel.getByText(/Paid: ₹100\.00/)).toBeVisible();
});

test('money paid by link beyond the bill goes back through the gateway by itself', async ({
  page,
}) => {
  const books = await shop('Refund Paints');
  await signIn(page, books);
  await page.goto(`/invoices/${books.invoice.id}`);
  const panel = page.getByRole('region', { name: 'UPI payment links' });
  await panel.getByRole('button', { name: 'Send a payment link to Deccan Contractors' }).click();
  const url = await makeLink(page);

  // The customer pays ₹300.00 on a link for the ₹236.00 bill.
  await page.goto(url);
  await page.getByLabel('Amount to pay (₹)').fill('300');
  await page.getByRole('button', { name: 'Pay by UPI (test)' }).click();
  await expect(page.getByText('Paid: the payment is recorded and allocated.')).toBeVisible();

  // ₹64.00 went back by itself: the bill is paid and nothing is left as an advance.
  await page.goto(`/invoices/${books.invoice.id}`);
  await expect(panel.getByText('Refunded ₹64.00')).toBeVisible();
  const ledger = await call<{ balancePaise: number; advancePaise: number }>(
    'GET',
    `/parties/${books.contractor}/ledger`,
    { token: books.business.token },
  );
  expect(ledger).toMatchObject({ balancePaise: 0, advancePaise: 0 });
  await page.goto('/payment-links');
  const links = page.getByRole('table', { name: 'Payment links' });
  await expect(links.getByText('Refunded ₹64.00')).toBeVisible();
  await expectUsable(page);
  // The customer ledger shows the refund beside the link payment.
  await page.goto(`/parties/${books.contractor}/ledger`);
  await expect(page.getByText(/^Refund/).first()).toBeVisible();
  await expect(page.getByText(/RF-\d{6}/).first()).toBeVisible();
});

test('Settings → Payment link settings: the business’s link rules, on desktop and on a phone in Hindi and Telugu', async ({
  page,
  browser,
}) => {
  const books = await shop('Link Rules Paints');
  await signIn(page, books);
  await page.goto('/settings/payment-links');
  await expect(page.getByRole('heading', { name: 'Payment links', level: 1 })).toBeVisible();
  // The log gateway: no Razorpay account to connect, only the rules.
  await expect(page.getByText(/Links use the test gateway here/)).toBeVisible();
  const rules = page.getByRole('region', { name: 'How links work' });
  await expect(rules.getByLabel('Payable for (minutes)')).toHaveValue('10');
  await expect(rules.getByLabel('Most one link asks for (₹)')).toHaveValue('100000.00');
  await expectUsable(page);
  await rules.getByLabel('Payable for (minutes)').fill('30');
  await rules.getByLabel('Most one link asks for (₹)').fill('200');
  await rules.getByLabel('Links ask for').selectOption('full');
  await rules.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Payment link settings saved')).toBeVisible();
  await page.reload();
  await expect(rules.getByLabel('Payable for (minutes)')).toHaveValue('30');

  // The cap holds: the ₹236.00 bill is more than one link may ask for now.
  await page.goto(`/invoices/${books.invoice.id}`);
  await page
    .getByRole('region', { name: 'UPI payment links' })
    .getByRole('button', { name: 'Send a payment link to Deccan Contractors' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Send a UPI payment link' });
  await dialog.getByRole('button', { name: 'Make link' }).click();
  await expect(dialog.getByText(/A link asks for at most ₹200\.00/)).toBeVisible();

  // The same screen on a phone, in Hindi and in Telugu.
  for (const [name, messages] of [
    ['हिन्दी', hi],
    ['తెలుగు', te],
  ] as const) {
    const context = await browser.newContext({ ...devices['Pixel 5'] });
    const phone = await context.newPage();
    await signInWithPassword(phone, books.business.ownerPhone);
    await phone.goto('/settings/security');
    await phone.getByRole('group', { name: 'Language' }).getByRole('button', { name }).click();
    await expect(
      phone.getByRole('heading', { name: messages.security.title, level: 1 }),
    ).toBeVisible();
    await phone.goto('/settings/payment-links');
    await expect(
      phone.getByRole('heading', { name: messages.paymentLinkSettings.title, level: 1 }),
    ).toBeVisible();
    await expect(
      phone.getByRole('region', { name: messages.paymentLinkSettings.rules.title }),
    ).toBeVisible();
    await expectUsable(phone);
    await context.close();
  }
});
