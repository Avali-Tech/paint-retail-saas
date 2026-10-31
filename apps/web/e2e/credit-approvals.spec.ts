import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import {
  addMember,
  call,
  createBusiness,
  openFromMenu,
  PASSWORD,
  signInWithPassword,
  type Business,
  uniquePhone,
} from './support.js';

// Credit enforcement (MVP 3 round 1a, P2-M09): live exposure from real bills and
// payments, approvals routed to the owner or a manager, the approval prompt at the
// order and at the counter, and site accounts.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Shop {
  readonly business: Business;
  readonly storeId: string;
  readonly paintId: string;
  readonly partyId: string;
  readonly partyPhone: string;
}

/**
 * A GST-registered shop billing in the system (gone live today) with a paint at
 * ₹5,000 and a contractor whose ₹30,000 limit carries ₹18,000 owed: a ₹20,000 bill
 * on account and a ₹2,000 bank transfer, as the spec §6.3 example has it.
 */
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
    { variantId: paintId, quantity: 20, unitCostPaise: 4_000_00 },
  ]);
  const partyPhone = uniquePhone();
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Apex Builders', phone: partyPhone, roles: ['customer', 'contractor'] },
  });
  const request = await call<{ id: string }>('POST', '/credit-requests', {
    token,
    body: { partyId: party.id, limitPaise: 30_000_00, creditDays: 30 },
  });
  await call('POST', `/credit-requests/${request.id}/approve`, { token, body: {} });
  await call('POST', '/sales/go-live', { token, body: {} });
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: { storeId, partyId: party.id, lines: [{ variantId: paintId, quantity: 4 }] },
  });
  await call('POST', `/invoices/${draft.id}/issue`, { token, body: {} });
  const modes = await call<{ id: string; kind: string }[]>('GET', '/payment-modes', { token });
  await call('POST', '/payments', {
    token,
    body: {
      storeId,
      partyId: party.id,
      modeId: modes.find((mode) => mode.kind === 'bank_transfer')?.id,
      amountPaise: 2_000_00,
      reference: 'NEFT0001',
    },
  });
  return { business, storeId, paintId, partyId: party.id, partyPhone };
}

test('the spec §6.3 example: a sales executive asks, the owner approves from the queue, the order confirms', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { business, storeId, paintId, partyId } = await shop('Approval Paints');
  const salesPhone = uniquePhone();
  await addMember(business, 'sales_executive', {
    fullName: 'Vikram Sales',
    phone: salesPhone,
    password: PASSWORD,
  });
  // ₹15,000 on credit on top of ₹18,000 owed: 110 % of the limit.
  const order = await call<{ id: string }>('POST', '/sales-orders', {
    token: business.token,
    body: {
      storeId,
      billToPartyId: partyId,
      paymentTerms: 'postpaid',
      lines: [{ variantId: paintId, quantity: 3 }],
    },
  });

  const sales = await (await browser.newContext()).newPage();
  await signInWithPassword(sales, salesPhone);
  await expect(sales.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await sales.goto(`/sales-orders/${order.id}`);
  const credit = sales.getByRole('region', { name: 'Credit' });
  await expect(credit).toContainText(
    'Limit₹30,000.00Owed now₹18,000.00This order₹15,000.00Against the limit110%',
  );
  await credit.getByRole('button', { name: 'Ask for approval' }).click();
  const ask = sales.getByRole('dialog', { name: 'Ask for credit approval' });
  await ask.getByRole('textbox', { name: 'Why this sale should go ahead' }).fill('Big site');
  await expectUsable(sales);
  await ask.getByRole('button', { name: 'Send for approval' }).click();
  await expect(
    credit.getByRole('link', { name: /^AP-\d+ is waiting for the owner to approve$/ }),
  ).toBeVisible();
  await sales.getByRole('button', { name: 'Confirm' }).click();
  await sales.getByRole('dialog').getByRole('button', { name: 'Confirm order' }).click();
  await expect(sales.getByRole('dialog')).toContainText(/is waiting for the owner to approve/);
  await sales.keyboard.press('Escape');

  // The owner finds it in the queue (the notification leads there too) and approves.
  const owner = await (await browser.newContext()).newPage();
  await signInWithPassword(owner, business.ownerPhone);
  await expect(owner.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await openFromMenu(owner, 'Customers', 'Credit approvals');
  const queue = owner.getByRole('table', { name: 'Credit approvals' });
  await expect(queue).toContainText('Apex Builders');
  await expect(queue).toContainText('₹15,000.00');
  await expect(queue).toContainText('Vikram Sales');
  await expectUsable(owner);
  await queue.getByRole('link', { name: /^AP-\d+$/ }).click();
  await expect(owner.getByRole('region', { name: 'When it was asked' })).toContainText(
    'Owes after it₹33,000.00',
  );
  await expectUsable(owner);
  await owner.getByRole('button', { name: /^Approve AP-/ }).click();
  await owner.getByRole('dialog').getByRole('textbox', { name: 'Reason (optional)' }).fill('Known');
  await owner.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(owner.getByText('Approved', { exact: true }).first()).toBeVisible();

  // The order now confirms, recording who approved it.
  await sales.reload();
  await expect(credit).toContainText(/AP-\d+ is approved: confirm the order now/);
  await sales.getByRole('button', { name: 'Confirm' }).click();
  await sales.getByRole('dialog').getByRole('button', { name: 'Confirm order' }).click();
  await expect(credit).toContainText('At confirm: Owner approval, 110% of the limit.');
  await expect(credit).toContainText('Known');

  // The customer 360 shows what is owed live: the ledger and the open order.
  await owner.goto(`/parties/${partyId}`);
  const live = owner.getByRole('region', { name: 'Credit' });
  await expect(live).toContainText('Owes now (ledger and open orders)₹33,000.00');
  await expect(live).toContainText('Balance in the ledger₹18,000.00');
  await expect(live).toContainText('Open orders on credit₹15,000.00');
  await expect(live.getByRole('button', { name: 'Update balance' })).toHaveCount(0);
  await expectUsable(owner);
});

test('a cashier asks for approval at the counter; the owner opens a site account', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { business, storeId, partyId, partyPhone } = await shop('Counter Credit Paints');
  const cashierPhone = uniquePhone();
  await addMember(business, 'store_employee', {
    fullName: 'Ravi Cashier',
    phone: cashierPhone,
    password: PASSWORD,
  });

  // Two packs, ₹10,000, with ₹100 paid by UPI: ₹27,900 owed is 93 % of the limit, so a
  // manager must approve what stays on credit.
  const cashier = await (await browser.newContext()).newPage();
  await signInWithPassword(cashier, cashierPhone);
  await expect(cashier.locator('.shell__header')).toBeVisible();
  await openFromMenu(cashier, 'New sale');
  const scan = cashier.getByRole('combobox', { name: 'Scan or search' });
  await expect(scan).toBeFocused();
  await scan.fill('2*APX-20L');
  await scan.press('Enter');
  await expect(cashier.getByRole('list', { name: 'Bill' })).toBeVisible();
  await cashier.getByRole('textbox', { name: 'Customer mobile' }).fill(partyPhone.slice(-10));
  await cashier.getByRole('button', { name: 'Find customer' }).click();
  await expect(cashier.getByText('Apex Builders')).toBeVisible();
  await expect(cashier.getByText('Bill saved')).toBeVisible();
  await cashier.keyboard.press('F8');
  const pay = cashier.getByRole('dialog', { name: 'Payment' });
  await pay
    .getByRole('radiogroup', { name: 'Mode of payment 1' })
    .getByRole('radio', { name: 'UPI' })
    .check();
  const amount = pay.getByRole('textbox', { name: 'Amount of payment 1' });
  await amount.fill('100');
  // The counter moves the rest to a second payment: removing it leaves the rest on account.
  await pay.getByRole('button', { name: 'Remove payment 2' }).click();
  await expect(pay.getByRole('textbox', { name: 'Amount of payment 1' })).toHaveValue('100');
  await pay.getByRole('button', { name: 'Issue bill' }).click();
  const check = cashier.getByRole('dialog', { name: 'Credit check' });
  await expect(check).toContainText('a manager must approve');
  await expectUsable(cashier);
  await check.getByRole('textbox', { name: 'Why this sale should go ahead' }).fill('Regular');
  await check.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(cashier.getByText(/the bill is held until it is decided/)).toBeVisible();
  await expect(cashier.getByRole('button', { name: 'Held (1)' })).toBeVisible();

  // The owner gives the contractor a site account on its project.
  const project = await call<{ id: string }>('POST', '/projects', {
    token: business.token,
    body: { storeId, customerPartyId: partyId, name: 'Jubilee Hills villa' },
  });
  const owner = await (await browser.newContext()).newPage();
  await signInWithPassword(owner, business.ownerPhone);
  await expect(owner.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await owner.goto(`/parties/${partyId}`);
  const credit = owner.getByRole('region', { name: 'Credit' });
  await expect(credit).toContainText('No site accounts yet');
  await credit.getByRole('button', { name: 'Add site account' }).click();
  const add = owner.getByRole('dialog', { name: 'Add a site account' });
  await add.getByRole('combobox', { name: 'Site (project)' }).selectOption(project.id);
  await add.getByRole('textbox', { name: 'Site limit (₹)' }).fill('10000');
  await expectUsable(owner);
  await add.getByRole('button', { name: 'Add site account' }).click();
  await expect(owner.getByText('Site account added')).toBeVisible();
  await credit.getByRole('link', { name: 'Jubilee Hills villa' }).click();
  await expect(
    owner.getByRole('heading', { name: 'Jubilee Hills villa · Site account', level: 1 }),
  ).toBeVisible();
  await expect(owner.getByRole('region', { name: 'Position' })).toContainText(
    'Site limit₹10,000.00',
  );
  await expect(owner.getByText('Nothing billed on this site yet')).toBeVisible();
  await expectUsable(owner);
});

test('the approval queue, an approval and a site account fit a phone @phone', async ({ page }) => {
  const { business, storeId, paintId, partyId } = await shop('Phone Approval Paints');
  const { token } = business;
  // Two more packs on account: ₹28,000 owed is 93 % of the limit, for a manager to approve.
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: { storeId, partyId, lines: [{ variantId: paintId, quantity: 2 }] },
  });
  const approval = await call<{ id: string; number: string }>('POST', '/credit-approvals', {
    token,
    body: { invoiceId: draft.id, amountPaise: 10_000_00, reason: 'Site needs it today' },
  });
  const project = await call<{ id: string }>('POST', '/projects', {
    token,
    body: { storeId, customerPartyId: partyId, name: 'Banjara Hills duplex' },
  });
  const site = await call<{ id: string }>('POST', `/parties/${partyId}/sites`, {
    token,
    body: { projectId: project.id, limitPaise: 10_000_00 },
  });

  await signInWithPassword(page, business.ownerPhone);
  await page.goto('/credit/approvals');
  await expect(page.getByRole('heading', { name: 'Credit approvals', level: 1 })).toBeVisible();
  await expectUsable(page);
  await page.goto(`/credit/approvals/${approval.id}`);
  await expect(
    page.getByRole('heading', { name: `${approval.number} · Credit approval`, level: 1 }),
  ).toBeVisible();
  await expectUsable(page);
  await page.goto(`/site-accounts/${site.id}`);
  await expect(
    page.getByRole('heading', { name: 'Banjara Hills duplex · Site account', level: 1 }),
  ).toBeVisible();
  await expectUsable(page);
});
