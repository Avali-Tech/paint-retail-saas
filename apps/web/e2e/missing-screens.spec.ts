import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import {
  call,
  createBusiness,
  openFromMenu,
  signInWithPassword,
  type Business,
} from './support.js';

// The screens that were dead ends (docs/mvp-3/navigation-ux.md §4, step 3): a payment on
// account with its allocation, a cheque that bounces and a refund; reprinting and
// cancelling an invoice; message templates; and the Getting started checklist.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Shop {
  readonly business: Business;
  readonly storeId: string;
  /** A 4-inch paint brush: ₹118 a piece, GST included. */
  readonly brush: string;
  readonly modes: Readonly<Record<string, string>>;
  /** Deccan Contractors, a customer who buys on account. */
  readonly partyId: string;
}

/** A GST-registered store selling brushes, with a customer on account. */
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
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Deccan Contractors', roles: ['customer'] },
  });
  return {
    business,
    storeId,
    brush,
    modes: Object.fromEntries(modes.map((mode) => [mode.kind, mode.id])),
    partyId: party.id,
  };
}

/** A bill for one brush to the customer, left on their account. */
async function bill({ business, storeId, brush, partyId }: Shop) {
  const { token } = business;
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: { storeId, partyId, lines: [{ variantId: brush, quantity: 1 }] },
  });
  return call<{ id: string; number: string; totalPaise: number; issuedOn: string }>(
    'POST',
    `/invoices/${draft.id}/issue`,
    { token, body: {} },
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
const printed = (page: Page) =>
  page.evaluate(() => (window as unknown as { printed: number }).printed);

test('a cheque on account settles a bill, bounces, and an advance is refunded', async ({
  page,
}) => {
  test.slow();
  const deccan = await shop('Cheque Paints');
  const invoice = await bill(deccan);
  await signInWithPassword(page, deccan.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();

  await openFromMenu(page, 'Money', 'Payments');
  await page.getByRole('link', { name: 'Take a payment' }).click();
  await expect(page.getByRole('heading', { name: 'Take a payment', level: 1 })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill('Deccan');
  await page.getByRole('button', { name: 'Choose Deccan Contractors' }).click();

  const form = page.getByRole('form', { name: 'Payment on account' });
  await form.getByRole('combobox', { name: /Paid by/ }).selectOption({ label: 'Cheque' });
  await form.getByRole('textbox', { name: 'Amount (₹)', exact: true }).fill('200');
  await form.getByRole('textbox', { name: /Cheque number/ }).fill('004512');
  await form.getByLabel(/Date on the cheque/).fill(invoice.issuedOn);
  const bills = form.getByRole('table', { name: 'Bills due' });
  await expect(
    bills.getByRole('textbox', { name: `Amount against ${invoice.number}` }),
  ).toHaveValue('118.00');
  await expect(form.getByLabel('How the money is used')).toContainText(
    'Against bills₹118.00Stays as advance₹82.00',
  );
  await expectUsable(page);
  await form.getByRole('button', { name: 'Take ₹200.00' }).click();

  await expect(page.getByRole('heading', { name: /^Payment RC-/, level: 1 })).toBeVisible();
  const details = page.getByRole('region', { name: 'Details' });
  await expect(details).toContainText('Cheque pending');
  await expect(details).toContainText('Not against any bill (advance)₹82.00');
  await expect(page.getByRole('table', { name: 'Bills paid' })).toContainText(invoice.number);
  await expectUsable(page);

  // The bank returns it: the bill is owed again, with a ₹150 charge.
  await page.getByRole('button', { name: 'Cheque bounced' }).click();
  const bounce = page.getByRole('dialog', { name: 'Cheque 004512 bounced' });
  await bounce.getByRole('textbox', { name: /Reason/ }).fill('Funds insufficient');
  await bounce.getByRole('textbox', { name: /Bounce charge/ }).fill('150');
  await bounce.getByRole('button', { name: 'Cheque bounced' }).click();
  await expect(details).toContainText('Bounced');
  await expect(details).toContainText('Funds insufficient');
  await expect(page.getByRole('table', { name: 'Bills paid' })).toContainText('Cheque bounced');

  await page.getByRole('link', { name: 'Customer account' }).click();
  await expect(page.locator('.facts')).toContainText('Balance today₹268.00 Dr');

  // Money paid ahead by bank transfer, all kept as an advance, then ₹40 of it paid back.
  await page.getByRole('link', { name: 'Take a payment' }).click();
  const advance = page.getByRole('form', { name: 'Payment on account' });
  await advance.getByRole('combobox', { name: /Paid by/ }).selectOption({ label: 'Bank transfer' });
  await advance.getByRole('textbox', { name: 'Amount (₹)', exact: true }).fill('100');
  await advance.getByRole('textbox', { name: /Reference/ }).fill('UTR778899');
  await advance.getByRole('button', { name: 'Clear all' }).click();
  await expect(advance.getByLabel('How the money is used')).toContainText(
    'Against bills₹0.00Stays as advance₹100.00',
  );
  await advance.getByRole('button', { name: 'Take ₹100.00' }).click();
  await expect(page.getByRole('heading', { name: /^Payment RC-/, level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Refund advance' }).click();
  const refund = page.getByRole('dialog', { name: /^Refund from RC-/ });
  await refund.getByRole('textbox', { name: /Amount to refund/ }).fill('40');
  await refund.getByRole('button', { name: 'Refund advance' }).click();
  await expect(page.getByRole('heading', { name: /^Refund RF-/, level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Details' })).toContainText('Amount₹40.00');
  await expectUsable(page);
});

test('an issued invoice is reprinted on A4 and 80 mm, as a PDF, and cancelled the same day', async ({
  page,
}) => {
  const shopFront = await shop('Reprint Paints');
  const invoice = await bill(shopFront);
  // A bill already paid cannot be cancelled: a credit note is the way.
  const paid = await bill(shopFront);
  await call('POST', '/payments', {
    token: shopFront.business.token,
    body: {
      storeId: shopFront.storeId,
      partyId: shopFront.partyId,
      modeId: shopFront.modes.bank_transfer,
      amountPaise: paid.totalPaise,
      reference: 'UTR1',
      allocations: [{ documentId: paid.id, amountPaise: paid.totalPaise }],
    },
  });
  await stubPrint(page);
  await signInWithPassword(page, shopFront.business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();

  await page.goto(`/invoices/${invoice.id}`);
  await expect(
    page.getByRole('heading', { name: `Invoice ${invoice.number}`, level: 1 }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Print A4' }).click();
  await expect.poll(() => printed(page)).toBe(1);
  await expect(page.getByTestId('print-layer')).toHaveAttribute('data-format', 'a4');
  await page.getByRole('button', { name: 'Print 80 mm' }).click();
  await expect.poll(() => printed(page)).toBe(2);
  await expect(page.getByTestId('print-layer')).toHaveAttribute('data-format', 'thermal');
  const [pdf] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'PDF', exact: true }).click(),
  ]);
  expect(pdf.suggestedFilename()).toBe(`${invoice.number.replaceAll('/', '-')}.pdf`);
  expect(
    readFileSync(await pdf.path())
      .subarray(0, 5)
      .toString(),
  ).toBe('%PDF-');
  await expectUsable(page);

  await page.getByRole('button', { name: 'Cancel invoice' }).click();
  const cancel = page.getByRole('dialog', { name: `Cancel invoice ${invoice.number}` });
  await cancel.getByRole('textbox', { name: /Reason/ }).fill('Billed the wrong customer');
  await cancel.getByRole('button', { name: 'Cancel invoice' }).click();
  await expect(page.getByText(`Invoice ${invoice.number} cancelled`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Details' })).toContainText('Cancelled');
  await expect(page.getByRole('region', { name: 'Details' })).toContainText(
    'Billed the wrong customer',
  );
  await expect(page.getByRole('button', { name: 'Print A4' })).toBeHidden();

  await page.goto(`/invoices/${paid.id}`);
  await page.getByRole('button', { name: 'Cancel invoice' }).click();
  const refused = page.getByRole('dialog', { name: `Cancel invoice ${paid.number}` });
  await refused.getByRole('textbox', { name: /Reason/ }).fill('Wrong rate');
  await refused.getByRole('button', { name: 'Cancel invoice' }).click();
  await expect(
    refused.getByText(
      'Payments are allocated to this invoice: undo them first, or raise a credit note',
    ),
  ).toBeVisible();
  await expectUsable(page);
});

test('an owner rewords a message template and sees the preview', async ({ page }) => {
  const business = await createBusiness('Template Paints', [['AMP', 'Ameerpet']]);
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await openFromMenu(page, 'Settings', 'Message templates');
  await expect(page.getByRole('heading', { name: 'Message templates', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Message' }).selectOption({ label: 'Order ready' });
  await page.getByRole('combobox', { name: 'Sent by' }).selectOption({ label: 'SMS' });
  const body = page.getByRole('textbox', { name: 'Message' });
  await body.fill('Namaste {{name}}, order {{number}} is packed at {{business}}.');
  await expect(page.getByRole('region', { name: 'Preview' })).toContainText(
    'Namaste Lakshmi, order AMP/26-27/000123 is packed at Template Paints.',
  );
  await body.fill('GST {{gstin}}');
  await expect(page.getByText('{{gstin}} is not a detail of this message')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save wording' })).toBeDisabled();
  await body.fill('Namaste {{name}}, order {{number}} is packed at {{business}}.');
  await page.getByRole('button', { name: 'Save wording' }).click();
  await expect(page.getByText('Template saved')).toBeVisible();
  await expect(page.getByText('Your wording')).toBeVisible();
  await page.reload();
  await page.getByRole('combobox', { name: 'Message' }).selectOption({ label: 'Order ready' });
  await page.getByRole('combobox', { name: 'Sent by' }).selectOption({ label: 'SMS' });
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue(
    'Namaste {{name}}, order {{number}} is packed at {{business}}.',
  );
  await expectUsable(page);
  await page.getByRole('button', { name: 'Use standard wording' }).click();
  await expect(page.getByText('Standard wording', { exact: true })).toBeVisible();
});

test('Getting started ticks off steps from real data and can be hidden from Home', async ({
  page,
}) => {
  const business = await createBusiness('Fresh Start Paints', [['AMP', 'Ameerpet']]);
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  const card = page.getByRole('region', { name: 'Getting started' });
  // The owner is the team so far, and the store has no GST state yet.
  await expect(card).toContainText('0 of 9 done');

  await call('PUT', '/gst-registrations/business', {
    token: business.token,
    body: { legalName: 'Fresh Start Paints LLP' },
  });
  await call('PUT', `/gst-registrations/stores/${String(business.stores[0]?.id)}`, {
    token: business.token,
    body: { registrationType: 'unregistered', stateCode: '36' },
  });
  await call('PUT', '/credit-rules', {
    token: business.token,
    body: { normalUpToPercent: 80, managerUpToPercent: 100, holdAfterOverdueDays: 30 },
  });
  await page.reload();
  await expect(card).toContainText('2 of 9 done');
  await expectUsable(page);

  await card.getByRole('link', { name: 'See all' }).click();
  await expect(page.getByRole('heading', { name: 'Getting started', level: 1 })).toBeVisible();
  const steps = page.getByRole('list', { name: 'Steps' }).getByRole('listitem');
  await expect(steps.nth(0)).toContainText('Stores and GST');
  await expect(steps.nth(0)).toContainText('Done');
  await expect(steps.nth(4)).toContainText('To do');
  await page.getByRole('link', { name: 'Open: Your team' }).click();
  await expect(page).toHaveURL(/\/team$/);

  await openFromMenu(page, 'Home');
  await page
    .getByRole('region', { name: 'Getting started' })
    .getByRole('button', { name: 'Hide' })
    .click();
  await expect(page.getByRole('region', { name: 'Getting started' })).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Getting started' })).toBeHidden();
});

test('the new screens work on a phone @phone', async ({ page }) => {
  test.slow();
  const phoneShop = await shop('Phone Paints');
  const invoice = await bill(phoneShop);
  const payment = await call<{ id: string }>('POST', '/payments', {
    token: phoneShop.business.token,
    body: {
      storeId: phoneShop.storeId,
      partyId: phoneShop.partyId,
      modeId: phoneShop.modes.cheque,
      amountPaise: 20_000,
      reference: '004512',
      chequeDate: invoice.issuedOn,
    },
  });
  // A second bill stays due, for the payment form to list.
  await bill(phoneShop);
  await signInWithPassword(page, phoneShop.business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Getting started' })).toBeVisible();
  await expectUsable(page);

  await page.goto(`/payments/new?partyId=${phoneShop.partyId}`);
  await expect(page.getByRole('table', { name: 'Bills due' })).toBeVisible();
  await expectUsable(page);

  await page.goto(`/payments/${payment.id}`);
  await expect(page.getByRole('button', { name: 'Cheque bounced' })).toBeVisible();
  await expectUsable(page);

  await page.goto(`/invoices/${invoice.id}`);
  await expect(page.getByRole('button', { name: 'Print 80 mm' })).toBeVisible();
  await expectUsable(page);

  await page.goto('/settings/messages');
  await expect(page.getByRole('region', { name: 'Preview' })).toBeVisible();
  await expectUsable(page);

  await page.goto('/settings/getting-started');
  await expect(page.getByRole('list', { name: 'Steps' })).toBeVisible();
  await expectUsable(page);
});
