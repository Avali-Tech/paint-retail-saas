import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import {
  addMember,
  call,
  createBusiness,
  PASSWORD,
  signInWithPassword,
  storedToken,
  type Business,
  uniquePhone,
} from './support.js';

// The "Needs action" inbox (docs/mvp-3/navigation-ux.md, step 2): what waits on each
// member in one place, acted on inline, with its count on Home.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Shop {
  readonly business: Business;
  readonly storeId: string;
  readonly otherStoreId: string;
  readonly paintId: string;
  readonly partyId: string;
}

/**
 * A GST-registered shop with two stores, billing in the system, a ₹5,000 paint in
 * stock at the first, and a contractor with a ₹30,000 credit limit.
 */
async function shop(name: string): Promise<Shop> {
  const business = await createBusiness(name, [
    ['AMP', 'Ameerpet'],
    ['KKP', 'Kukatpally'],
  ]);
  const { token } = business;
  const storeId = String(business.stores[0]?.id);
  const otherStoreId = String(business.stores[1]?.id);
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
  const brand = await call<{ id: string }>('POST', '/brands', {
    token,
    body: { name: 'Asian Paints' },
  });
  const paint = await call<{ variants: { id: string }[] }>('POST', '/products', {
    token,
    body: {
      brandId: brand.id,
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '3209',
      taxCategoryId: categories.find((option) => option.key === 'paints')?.id,
      variants: [
        { sku: 'APX-20L', packSize: 20, unit: 'l', sellingPricePaise: 5_000_00, barcodes: [] },
      ],
    },
  });
  const paintId = String(paint.variants[0]?.id);
  await openingStock(business, storeId, [
    { variantId: paintId, quantity: 50, unitCostPaise: 4_000_00 },
  ]);
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: {
      displayName: 'Apex Builders',
      phone: uniquePhone(),
      roles: ['customer', 'contractor'],
    },
  });
  const request = await call<{ id: string }>('POST', '/credit-requests', {
    token,
    body: { partyId: party.id, limitPaise: 30_000_00, creditDays: 30 },
  });
  await call('POST', `/credit-requests/${request.id}/approve`, { token, body: {} });
  await call('POST', '/sales/go-live', { token, body: {} });
  return { business, storeId, otherStoreId, paintId, partyId: party.id };
}

/** A member with a password, signed in on their own page. */
async function member(
  browserPage: () => Promise<Page>,
  business: Business,
  roleKey: string,
  fullName: string,
): Promise<{ page: Page; phone: string }> {
  const phone = uniquePhone();
  await addMember(business, roleKey, { fullName, phone, password: PASSWORD });
  const page = await browserPage();
  await signInWithPassword(page, phone);
  await expect(page.locator('.shell__header')).toBeVisible();
  return { page, phone };
}

/** A bill of `packs` packs on credit, waiting for approval, asked by `token`. */
async function waitingBill(shop: Shop, token: string, packs: number): Promise<void> {
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: {
      storeId: shop.storeId,
      partyId: shop.partyId,
      lines: [{ variantId: shop.paintId, quantity: packs }],
    },
  });
  await call('POST', '/credit-approvals', {
    token,
    // ₹5,000 a pack, tax included.
    body: { invoiceId: draft.id, amountPaise: packs * 5_000_00, reason: 'Big site' },
  });
}

const homeLink = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: /^Home/ });

test('the owner sees a credit approval in the inbox and approves it there; the badge follows', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const theShop = await shop('Inbox Owner Paints');
  const sales = await member(
    async () => (await browser.newContext()).newPage(),
    theShop.business,
    'sales_executive',
    'Vikram Sales',
  );
  // ₹35,000 on a ₹30,000 limit: 117 %, for the owner.
  await waitingBill(theShop, await storedToken(sales.page), 7);

  const owner = await (await browser.newContext()).newPage();
  await signInWithPassword(owner, theShop.business.ownerPhone);
  await expect(homeLink(owner)).toHaveAccessibleName('Home, 1 waiting for you');
  await homeLink(owner).click();
  await owner
    .getByRole('navigation', { name: 'Home', exact: true })
    .getByRole('link', { name: 'Inbox, 1 waiting for you' })
    .click();
  await expect(owner.getByRole('heading', { name: 'Needs action', level: 1 })).toBeVisible();
  const approvals = owner.getByRole('region', { name: 'Credit approvals (1)' });
  await expect(approvals).toContainText('Apex Builders');
  await expect(approvals).toContainText('Sale on credit to approve');
  await expect(approvals).toContainText('₹35,000.00');
  await expect(approvals).toContainText('By Vikram Sales');
  await expectUsable(owner);
  await approvals.getByRole('button', { name: /^Approve AP-/ }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(owner.getByText('Nothing waiting for you')).toBeVisible();
  await expect(homeLink(owner)).toHaveAccessibleName('Home');
  await expectUsable(owner);
});

test('a branch manager approves a transfer from the inbox; next it waits to be dispatched', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const theShop = await shop('Inbox Transfer Paints');
  const transfer = await call<{ number: string }>('POST', '/transfers', {
    token: theShop.business.token,
    body: {
      fromStoreId: theShop.storeId,
      toStoreId: theShop.otherStoreId,
      lines: [{ variantId: theShop.paintId, quantity: 4 }],
    },
  });
  const { page } = await member(
    async () => (await browser.newContext()).newPage(),
    theShop.business,
    'branch_manager',
    'Meena Manager',
  );
  await expect(homeLink(page)).toHaveAccessibleName('Home, 1 waiting for you');
  await page.goto('/inbox');
  const transfers = page.getByRole('region', { name: 'Transfers (1)' });
  await expect(transfers).toContainText('Ameerpet → Kukatpally');
  await expect(transfers).toContainText(`To approve · ${transfer.number} · Ameerpet`);
  await transfers.getByRole('button', { name: `Approve transfer ${transfer.number}` }).click();
  await expect(page.getByText('Transfer approved')).toBeVisible();
  await expect(transfers).toContainText(`To dispatch · ${transfer.number}`);
  await expect(transfers.getByRole('link', { name: `Dispatch: ${transfer.number}` })).toBeVisible();
  await expectUsable(page);
});

test('a sales executive’s inbox has their follow-ups, and no approvals', async ({ browser }) => {
  test.setTimeout(120_000);
  const theShop = await shop('Inbox Sales Paints');
  const { page } = await member(
    async () => (await browser.newContext()).newPage(),
    theShop.business,
    'sales_executive',
    'Vikram Sales',
  );
  const token = await storedToken(page);
  // An approval they asked for themselves, and a follow-up of theirs overdue since yesterday.
  await waitingBill(theShop, token, 7);
  await call('POST', '/activities', {
    token,
    body: {
      recordType: 'party',
      recordId: theShop.partyId,
      type: 'call',
      subject: 'Ask about the site visit',
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
  });
  await page.goto('/inbox');
  const followUps = page.getByRole('region', { name: 'Follow-ups (1)' });
  await expect(followUps).toContainText('Ask about the site visit');
  await expect(followUps).toContainText('Overdue · Apex Builders');
  await expect(page.getByRole('region', { name: /^Credit approvals/ })).toHaveCount(0);
  await expect(
    page.getByRole('combobox', { name: 'Show' }).getByRole('option', { name: 'Credit approvals' }),
  ).toHaveCount(0);
  await expect(homeLink(page)).toHaveAccessibleName('Home, 1 waiting for you');
  await followUps.getByRole('button', { name: 'Mark “Ask about the site visit” done' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Mark done' }).click();
  await expect(page.getByText('Nothing waiting for you')).toBeVisible();
  await expect(homeLink(page)).toHaveAccessibleName('Home');
});

test('the inbox fits a phone @phone', async ({ page }) => {
  test.setTimeout(120_000);
  const theShop = await shop('Inbox Phone Paints');
  const { token } = theShop.business;
  await call('POST', '/transfers', {
    token,
    body: {
      fromStoreId: theShop.storeId,
      toStoreId: theShop.otherStoreId,
      lines: [{ variantId: theShop.paintId, quantity: 4 }],
    },
  });
  await call('PUT', '/reorder-rules', {
    token,
    body: {
      rules: [
        {
          storeId: theShop.storeId,
          variantId: theShop.paintId,
          minQuantity: 60,
          reorderLevel: 80,
          maxQuantity: 120,
        },
      ],
    },
  });
  await call('POST', '/activities', {
    token,
    body: {
      recordType: 'party',
      recordId: theShop.partyId,
      type: 'visit',
      subject: 'Measure the long wall at the Kondapur site for the estimate',
      dueAt: new Date().toISOString(),
    },
  });
  await signInWithPassword(page, theShop.business.ownerPhone);
  const bar = page.getByRole('navigation', { name: 'Main' }).last();
  await expect(bar.getByRole('link', { name: /^Home/ })).toHaveAccessibleName(
    'Home, 3 waiting for you',
  );
  await page.goto('/inbox');
  await expect(page.getByRole('region', { name: 'Low stock (1)' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Transfers (1)' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Follow-ups (1)' })).toBeVisible();
  await expectUsable(page);
});
