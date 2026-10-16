import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, uniquePhone, type Business } from './support.js';

// Receivables and statements (roadmap P2-M10, P2-M12): what a contractor owes, aged,
// with the way to the ledger; and the contractor's statement, produced and shared on
// WhatsApp from the customer record. The end-to-end API has a WhatsApp provider (log),
// so sharing stores a link (round 2a); a customer who has not agreed to messages gets
// it through wa.me (collections.spec.ts sends it to one who has).

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Books {
  readonly business: Business;
  readonly contractor: { readonly id: string; readonly phone: string };
  readonly invoice: { readonly number: string; readonly issuedOn: string };
}

/**
 * A registered store and a contractor with one overdue bill of ₹236 (due in 2020, so
 * its age never depends on today's date), part paid with ₹100.
 */
async function books(name: string): Promise<Books> {
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
  const invoice = await call<{ id: string; number: string; issuedOn: string }>(
    'POST',
    `/invoices/${draft.id}/issue`,
    { token, body: {} },
  );
  const modes = await call<{ id: string; kind: string }[]>('GET', '/payment-modes', { token });
  await call('POST', '/payments', {
    token,
    body: {
      storeId,
      partyId: contractor.id,
      modeId: modes.find((mode) => mode.kind === 'upi')?.id,
      amountPaise: 10_000,
      reference: 'UTR10001',
      allocations: [{ documentId: invoice.id, amountPaise: 10_000 }],
    },
  });
  return { business, contractor: { id: contractor.id, phone }, invoice };
}

async function signIn(page: Page, shop: Books) {
  await signInWithPassword(page, shop.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
}

test('a contractor’s statement is produced and shared on WhatsApp as a link', async ({ page }) => {
  const shop = await books('Statement Paints');
  // WhatsApp itself stays out of the test: its page answers from here.
  await page
    .context()
    .route('https://wa.me/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>WhatsApp</title>' }),
    );
  await signIn(page, shop);
  await page.goto(`/parties/${shop.contractor.id}`);
  await expect(page.getByRole('heading', { name: 'Deccan Contractors', level: 1 })).toBeVisible();

  // Click 1: the statement, for this financial year up to today.
  await page.getByRole('link', { name: 'Statement', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Statement · Deccan Contractors', level: 1 }),
  ).toBeVisible();
  const paper = page.getByRole('article', { name: 'Statement of Account · Deccan Contractors' });
  await expect(paper).toContainText('Statement Paints');
  await expect(paper).toContainText(`Invoice${shop.invoice.number}236.00236.00 Dr`);
  await expect(paper).toContainText('Payment received');
  await expect(paper).toContainText('Total236.00100.00136.00 Dr');
  await expect(paper).toContainText('Over 90 days136.00');
  await expectUsable(page);

  // Click 2: the link is stored; without the customer's consent to WhatsApp messages
  // the message goes through wa.me, carrying the link to the PDF.
  await page.getByRole('button', { name: 'Send on WhatsApp' }).click();
  await expect(page.getByText(/has not agreed to WhatsApp messages/)).toBeVisible();
  const [whatsapp] = await Promise.all([
    page.waitForEvent('popup'),
    page.getByRole('link', { name: 'Open WhatsApp with the link' }).click(),
  ]);
  const digits = shop.contractor.phone.replace(/\D/g, '').slice(-10);
  expect(whatsapp.url()).toMatch(new RegExp(`^https://wa\\.me/91${digits}\\?text=`));
  const message = decodeURIComponent(new URL(whatsapp.url()).searchParams.get('text') ?? '');
  expect(message).toMatch(
    /^Dear Deccan Contractors, your statement from Statement Paints for 01 Apr \d{4} to \d{2} \w{3} \d{4}: balance due ₹136\.00 as of/,
  );
  expect(message).toMatch(
    // With payment links on (round 4a), the share also says where to pay by UPI.
    /Of this, ₹136\.00 is due now\. View the statement: http\S+\/api\/public\/statements\/[\w-]{43} Pay by UPI: http\S+\/pay\/plink_log_[\w-]{22}$/,
  );
  await expect(page.getByText(/Active · opened 0 times/)).toBeVisible();

  // The PDF still downloads for printing or attaching by hand.
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download PDF' }).click(),
  ]);
  expect(pdf.suggestedFilename()).toMatch(
    /^Statement-Deccan-Contractors-\d{4}-04-01-\d{4}-\d{2}-\d{2}\.pdf$/,
  );
  expect(
    readFileSync(await pdf.path())
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');
});

test('the receivables screen ages what customers owe and leads to the ledger', async ({ page }) => {
  const shop = await books('Receivables Paints');
  await signIn(page, shop);
  await expect(page.getByRole('heading', { name: 'Receivables' })).toBeVisible();
  await page.getByRole('link', { name: 'Open receivables' }).click();
  await expect(page.getByRole('heading', { name: 'Receivables', level: 1 })).toBeVisible();
  const tiles = page.getByRole('region', { name: 'Receivables figures' });
  await expect(tiles).toContainText('Total outstanding₹136.001 customer owes');
  await expect(tiles).toContainText('Overdue₹136.00');
  const table = page.getByRole('table', { name: 'Ageing by Customer' });
  await expect(table.getByRole('row').nth(1)).toContainText(
    'Deccan Contractors' + shop.contractor.phone,
  );
  await expect(table.getByRole('row').nth(1)).toContainText('₹136.00₹136.00₹0.00₹136.00');
  await expectUsable(page);

  await page.getByLabel('Group by').selectOption('store');
  const stores = page.getByRole('table', { name: 'Ageing by Store' });
  await expect(stores).toContainText('AMP · Ameerpet');
  await stores.getByRole('button', { name: 'Show the customers of Ameerpet' }).click();
  await expect(page.getByRole('table', { name: 'Ageing by Customer' })).toContainText(
    'Deccan Contractors',
  );
  await page
    .getByRole('table', { name: 'Ageing by Customer' })
    .getByRole('link', { name: 'Deccan Contractors' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Ledger · Deccan Contractors', level: 1 }),
  ).toBeVisible();
  await expect(page.locator('.facts')).toContainText('Balance today₹136.00 Dr');
});

test('receivables and the statement fit a phone @phone', async ({ page }) => {
  const shop = await books('Phone Receivables Paints');
  await signIn(page, shop);
  await page.goto('/receivables');
  await expect(page.getByRole('table', { name: 'Ageing by Customer' })).toContainText(
    'Deccan Contractors',
  );
  await expectUsable(page);
  await page.goto(`/parties/${shop.contractor.id}/statement`);
  await expect(page.getByRole('button', { name: 'Send on WhatsApp' })).toBeVisible();
  await expectUsable(page);
});
