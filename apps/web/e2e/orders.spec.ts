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

// Quote → order → invoice (spec §5.3, §7 Round 4 demo), for paint and hardware alike.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

interface Shop {
  readonly business: Business;
  readonly partyId: string;
  readonly storeId: string;
  readonly paintId: string;
}

/**
 * A GST-registered shop with a paint (₹5,000) and a hinge (₹500) in stock at Ameerpet,
 * and a contractor with a ₹30,000 credit limit who owes `owedPaise`.
 */
async function shop(name: string, owedPaise: number): Promise<Shop> {
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
  const storeId = String(business.stores[0]?.id);
  const { categories } = await call<{ categories: { id: string; key: string | null }[] }>(
    'GET',
    '/tax-categories/options',
    { token },
  );
  const category = (key: string) => categories.find((option) => option.key === key)?.id;
  const product = async (brandName: string, body: object) => {
    const brand = await call<{ id: string }>('POST', '/brands', {
      token,
      body: { name: brandName },
    });
    return call<{ variants: { id: string }[] }>('POST', '/products', {
      token,
      body: { brandId: brand.id, ...body },
    });
  };
  const paint = await product('Asian Paints', {
    name: 'Apex Ultima',
    type: 'exterior_paint',
    hsnCode: '3209',
    taxCategoryId: category('paints'),
    variants: [
      { sku: 'APX-20L', packSize: 20, unit: 'l', sellingPricePaise: 5_000_00, barcodes: [] },
    ],
  });
  // Hardware: a hinge, taxed like the shop's tools.
  const hinge = await product('Godrej', {
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
  });
  const paintId = String(paint.variants[0]?.id);
  await openingStock(business, storeId, [
    { variantId: paintId, quantity: 10, unitCostPaise: 4_000_00 },
    { variantId: String(hinge.variants[0]?.id), quantity: 50, unitCostPaise: 300_00 },
  ]);
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Apex Builders', roles: ['customer', 'contractor'] },
  });
  const request = await call<{ id: string }>('POST', '/credit-requests', {
    token,
    body: { partyId: party.id, limitPaise: 30_000_00, creditDays: 30 },
  });
  await call('POST', `/credit-requests/${request.id}/approve`, { token, body: {} });
  await call('PATCH', `/parties/${party.id}/credit`, {
    token,
    body: { risk: 'low', manualExposurePaise: owedPaise, overdueDays: 0 },
  });
  return { business, partyId: party.id, storeId, paintId };
}

async function chooseBillTo(page: Page, name: string) {
  await page.getByRole('button', { name: 'Choose Bill to' }).click();
  await page.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill(name);
  await page.getByRole('button', { name: `Choose ${name}` }).click();
}

test('quote v1 → v2 → order → reservation → partial invoice → dispatch', async ({ page }) => {
  test.setTimeout(90_000);
  const { business } = await shop('Quote Paints', 0);
  await page.addInitScript(() => {
    window.print = () => undefined;
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Quotations' }).first().click();
  await page.getByRole('link', { name: 'New quotation' }).click();
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'AMP · Ameerpet' });
  await chooseBillTo(page, 'Apex Builders');
  // A paint and a hardware item on the counter's grid.
  const scan = page.getByRole('combobox', { name: 'Scan or search' });
  await scan.fill('2*APX-20L');
  await scan.press('Enter');
  await scan.fill('10*HNG-4');
  await scan.press('Enter');
  await expect(page.getByText('Items total ₹15,000.00')).toBeVisible();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('heading', { name: /^Quotation QT-\d+ v1$/, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('table', { name: 'Lines' })).toContainText('Hinge 4 inch');

  // v1 goes out, the customer haggles: v2, with v1 kept as it was.
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await page.getByRole('button', { name: 'Revise' }).click();
  await expect(
    page.getByRole('heading', { name: /^Quotation QT-\d+ v2$/, level: 1 }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Edit QT-\d+$/, level: 1 })).toBeVisible();
  const discount = page.getByRole('textbox', { name: /^Discount on .*Apex Ultima/ });
  await discount.fill('10%');
  await discount.press('Enter');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByRole('heading', { name: /^Quotation QT-\d+ v2$/, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Versions' })).toContainText('Revised');
  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await expect(page.getByRole('button', { name: 'Convert to order' })).toBeVisible();
  await page.getByRole('button', { name: 'Print or save as PDF' }).click();
  await expect(page.getByTestId('quotation-print')).toContainText('This is a quotation');

  await page.getByRole('button', { name: 'Convert to order' }).click();
  await page.getByRole('button', { name: 'Make the order' }).click();
  await expect(page.getByRole('heading', { name: /^Sales order SO-\d+$/, level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Credit' })).toContainText(
    'Within the credit limit',
  );

  // Confirm reserves the stock at Ameerpet.
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Details' })).toContainText('Confirmed');
  await expect(page.getByRole('region', { name: 'Stock for this order' })).toContainText(
    'Ameerpet (this line’s store): 8 free (10 on hand, 2 held)',
  );

  // Bill the paint and 4 of the 10 hinges.
  await page.getByRole('button', { name: 'Bill', exact: true }).click();
  const bill = page.getByRole('dialog', { name: /^Bill SO-/ });
  await bill.getByRole('textbox', { name: /Hinge/ }).fill('4');
  await bill.getByRole('button', { name: 'Bill and issue' }).click();
  await expect(page.getByRole('heading', { name: /^Invoice AMP\//, level: 1 })).toBeVisible();

  // The goods leave with a dispatch.
  const dispatch = page.getByRole('region', { name: 'Dispatch', exact: true });
  await expect(dispatch.getByRole('table', { name: 'Dispatch lines' })).toBeVisible();
  await dispatch.getByRole('button', { name: 'Dispatch goods' }).click();
  await page.getByRole('textbox', { name: 'Vehicle number' }).fill('TS09AB1234');
  await page.getByRole('button', { name: 'Record dispatch' }).click();
  await expect(dispatch).toContainText(/DS-\d+/);
  await expect(dispatch.getByRole('button', { name: 'Dispatch goods' })).toHaveCount(0);
  await expectUsable(page);

  // The order is partly billed; 6 hinges are still open.
  await page.getByRole('link', { name: 'Sales orders' }).first().click();
  await page.getByRole('link', { name: /^SO-\d+$/ }).click();
  await expect(page.getByRole('region', { name: 'Details' })).toContainText('Partly billed');
  await expect(page.getByRole('region', { name: 'Invoices' })).toContainText('Issued');
});

test('an order at 110 % of the credit limit needs the owner', async ({ browser }) => {
  test.setTimeout(90_000);
  const { business, partyId, storeId, paintId } = await shop('Credit Paints', 18_000_00);
  const managerPhone = uniquePhone();
  await addMember(business, 'branch_manager', {
    fullName: 'Meena Manager',
    phone: managerPhone,
    password: PASSWORD,
  });
  // ₹15,000 on credit: ₹18,000 owed + ₹15,000 against a ₹30,000 limit = 110 %.
  const order = await call<{ id: string }>('POST', '/sales-orders', {
    token: business.token,
    body: {
      storeId,
      billToPartyId: partyId,
      paymentTerms: 'postpaid',
      lines: [{ variantId: paintId, quantity: 3 }],
    },
  });

  const manager = await (await browser.newContext()).newPage();
  await signInWithPassword(manager, managerPhone);
  await expect(manager.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await manager.goto(`/sales-orders/${order.id}`);
  const credit = manager.getByRole('region', { name: 'Credit' });
  await expect(credit).toContainText(
    'Limit₹30,000.00Owed now₹18,000.00This order₹15,000.00Against the limit110%',
  );
  await expect(credit).toContainText('Over the credit limit: the owner approves it.');
  await expect(credit).toContainText('Ask an owner to confirm this order');
  await credit.getByRole('button', { name: 'Request owner approval (limit ₹33,000.00)' }).click();
  await expect(
    credit.getByRole('link', { name: /^Credit request CR-\d+ is waiting for the owner$/ }),
  ).toBeVisible();

  // The owner confirms past the rules with a reason, recorded on the order.
  const owner = await (await browser.newContext()).newPage();
  await signInWithPassword(owner, business.ownerPhone);
  await expect(owner.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await owner.goto(`/sales-orders/${order.id}`);
  await expect(owner.getByRole('region', { name: 'Credit' })).toContainText(
    'You can approve it when you confirm.',
  );
  await owner.getByRole('button', { name: 'Confirm' }).click();
  const dialog = owner.getByRole('dialog', { name: /^Confirm SO-/ });
  await dialog.getByRole('textbox', { name: /Why you approve/ }).fill('Pays every month');
  await dialog.getByRole('button', { name: 'Approve and confirm' }).click();
  const after = owner.getByRole('region', { name: 'Credit' });
  await expect(after).toContainText('At confirm: Owner approval, 110% of the limit.');
  await expect(after).toContainText('Pays every month');
});
