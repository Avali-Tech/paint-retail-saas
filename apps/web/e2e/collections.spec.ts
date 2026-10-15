import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, uniquePhone, type Business } from './support.js';

// Collections (roadmap P2-M11) and party messaging (P2-M32): the worklist of overdue
// customers with a promise to pay recorded from it, the reminder schedule, and
// consent recorded on the customer record after reading the notice.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Shop {
  readonly business: Business;
  readonly contractor: { readonly id: string; readonly phone: string };
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
  const phone = uniquePhone();
  const contractor = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Deccan Contractors', phone, roles: ['customer', 'contractor'] },
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
  await call('POST', `/invoices/${draft.id}/issue`, { token, body: {} });
  return { business, contractor: { id: contractor.id, phone } };
}

async function signIn(page: Page, books: Shop) {
  await signInWithPassword(page, books.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
}

test('the worklist lists an overdue customer and records their promise to pay', async ({
  page,
}) => {
  const books = await shop('Collections Paints');
  await signIn(page, books);
  await page.goto('/collections');
  await expect(page.getByRole('heading', { name: 'Collections', level: 1 })).toBeVisible();
  // The owner looks after nobody: their own list is empty until they choose everyone's.
  await expect(page.getByText('Nothing is overdue for these customers.')).toBeVisible();
  await page.getByLabel('Whose customers').selectOption('all');
  const table = page.getByRole('table', { name: 'Collections worklist' });
  const row = table.getByRole('row').nth(1);
  await expect(row).toContainText('Deccan Contractors');
  await expect(row).toContainText('₹236.00');
  await expect(row).toContainText('Call or message');
  await expectUsable(page);

  await row.getByRole('button', { name: 'Record a promise from Deccan Contractors' }).click();
  const dialog = page.getByRole('dialog', { name: 'Promise to pay' });
  await expect(dialog).toContainText('At most what the customer owes: ₹236.00');
  await dialog.getByLabel(/Amount/).fill('200');
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Record promise' }).click();
  await expect(page.getByText('Promise recorded')).toBeVisible();
  await expect(row).toContainText('₹200.00 by');
  await expect(row).toContainText('Check the promised payment');

  // The promise is on the customer record too, with what has been paid towards it.
  await page.goto(`/parties/${books.contractor.id}`);
  const collections = page.getByRole('region', { name: 'Collections' });
  await expect(collections).toContainText('Promised ₹200.00 by');
  await expect(collections).toContainText('₹0.00 paid since');
});

test('the reminder schedule starts from the suggested days and is saved', async ({ page }) => {
  const books = await shop('Reminder Paints');
  await signIn(page, books);
  await page.goto('/collections');
  await page.getByRole('link', { name: 'Reminder schedule' }).click();
  await expect(page.getByRole('heading', { name: 'Reminder schedule', level: 1 })).toBeVisible();
  await expect(page.getByText(/No reminders are sent/)).toBeVisible();
  await page.getByRole('button', { name: 'Use the suggested schedule' }).click();
  const table = page.getByRole('table', { name: 'Reminders' });
  await expect(table.getByRole('row')).toHaveCount(6);
  await expect(table).toContainText('3 days before');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save schedule' }).click();
  await expect(page.getByText('Reminder schedule saved')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('table', { name: 'Reminders' })).toContainText('30 days after');
});

test('consent to WhatsApp is recorded after the notice, and the statement is then sent on WhatsApp', async ({
  page,
}) => {
  const books = await shop('Consent Paints');
  await signIn(page, books);
  await page.goto(`/parties/${books.contractor.id}`);
  const messages = page.getByRole('region', { name: 'Messages and consent' });
  await expect(messages).toContainText('Not asked');
  await messages.getByRole('button', { name: 'Record consent' }).click();
  const dialog = page.getByRole('dialog', { name: 'Consent to messages' });
  await dialog.getByLabel('Language of the notice and messages').selectOption('te');
  await expect(dialog).toContainText(`WhatsAppలో ${books.contractor.phone}కు`);
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Record' }).click();
  await expect(page.getByText('Consent recorded')).toBeVisible();
  await expect(messages).toContainText('Agreed');

  // Two clicks: the statement, then WhatsApp (the server's log provider sends it).
  await page.getByRole('link', { name: 'Statement', exact: true }).click();
  await page.getByRole('button', { name: 'Send on WhatsApp' }).click();
  await expect(page.getByText('Statement queued on WhatsApp')).toBeVisible();
  await expect(page.getByText(/Active · opened 0 times/)).toBeVisible();
  await expectUsable(page);

  // The queued message carries a link that opens the PDF without signing in.
  const [message] = await call<{ templateKey: string; body: string }[]>(
    'GET',
    `/parties/${books.contractor.id}/messages`,
    { token: books.business.token },
  );
  expect(message?.templateKey).toBe('statement_ready');
  const token = /\/public\/statements\/([A-Za-z0-9_-]{43})/.exec(String(message?.body))?.[1];
  const pdf = await page.request.get(`/api/public/statements/${String(token)}`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
});

test('the worklist and the reminder schedule fit a phone @phone', async ({ page }) => {
  const books = await shop('Phone Collections Paints');
  await signIn(page, books);
  await page.goto('/collections?whose=all');
  await expect(page.getByRole('table', { name: 'Collections worklist' })).toContainText(
    'Deccan Contractors',
  );
  await expectUsable(page);
  await page.goto('/collections/reminders');
  await page.getByRole('button', { name: 'Use the suggested schedule' }).click();
  await expectUsable(page);
});
