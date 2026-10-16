import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, signInWithPassword, uniquePhone, type Business } from './support.js';

// Pilot gaps (MVP 3 round 7a): the store screen (PO-102), the billing go-live screen
// (PO-100) and credit in the parties import (PO-101).

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

async function signIn(page: Page, business: Business) {
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

/** Two customers, one with an imported opening balance overdue since 15 Mar 2026. */
async function withOpenings(name: string) {
  const business = await createBusiness(name);
  const sharma = uniquePhone();
  const ravi = uniquePhone();
  for (const [displayName, phone] of [
    ['Sharma Constructions', sharma],
    ['Ravi Painter', ravi],
  ] as const) {
    await call('POST', '/parties', {
      token: business.token,
      body: { displayName, phone, roles: ['customer'] },
    });
  }
  await call('POST', '/imports/opening-balances', {
    token: business.token,
    body: {
      csv: `phone,opening_balance,overdue_since\r\n${sharma},45000,2026-03-15\r\n${ravi},1200,`,
    },
  });
  return business;
}

test('Settings → Stores: add a registered store, rename it, close and reopen it', async ({
  page,
}) => {
  const business = await createBusiness('Store Screen Paints');
  await call('PUT', '/gst-registrations/business', {
    token: business.token,
    body: { legalName: 'Store Screen Paints LLP' },
  });
  await signIn(page, business);
  await page.goto('/settings/stores');
  await expect(page.getByRole('heading', { name: 'Stores and godowns', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'New store' }).click();
  const create = page.getByRole('dialog', { name: 'New store' });
  await create.getByRole('textbox', { name: 'Name' }).fill('Kukatpally');
  await create.getByRole('textbox', { name: /^Code/ }).fill('KKP');
  await create.getByRole('combobox', { name: 'Registration type' }).selectOption('regular');
  await create.getByRole('combobox', { name: 'State' }).selectOption('36');
  await create.getByRole('textbox', { name: 'GSTIN' }).fill(TELANGANA_GSTIN);
  await create.getByRole('textbox', { name: 'PIN code' }).fill('500072');
  await expectUsable(page);
  await create.getByRole('button', { name: 'Add store' }).click();
  await expect(page.getByText('Store added')).toBeVisible();
  const list = page.getByRole('region', { name: 'Stores' });
  await expect(list).toContainText(`KKP · Kukatpally Store 36 · Telangana · ${TELANGANA_GSTIN}`);

  await page.getByRole('button', { name: 'Edit Kukatpally' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit KKP · Kukatpally' });
  await edit.getByRole('textbox', { name: 'Name' }).fill('Kukatpally Depot');
  await edit.getByRole('combobox', { name: 'Kind' }).selectOption('godown');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(list).toContainText('KKP · Kukatpally Depot Godown');

  await page.getByRole('button', { name: 'Close Kukatpally Depot' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close store' }).click();
  await expect(list).toContainText('KKP · Kukatpally Depot Godown Closed');
  await page.getByRole('button', { name: 'Reopen Kukatpally Depot' }).click();
  await expect(page.getByText('Store reopened')).toBeVisible();
  await expectUsable(page);

  // Tax & GST sees the registration made with the store.
  await page.goto('/settings/tax');
  await expect(page.getByRole('region', { name: 'GST registrations' })).toContainText(
    `36 · Telangana · ${TELANGANA_GSTIN}`,
  );
});

test('Settings → Billing go-live: review the openings, correct one, and go live once', async ({
  page,
}) => {
  const business = await withOpenings('Go-live Screen Paints');
  await signIn(page, business);
  await page.goto('/settings/go-live');
  await expect(page.getByRole('heading', { name: 'Billing go-live', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Opening balances' });
  await expect(table).toContainText('Sharma ConstructionsImported₹45,000.0015 Mar 2026');
  await expect(table).toContainText('Ravi PainterImported₹1,200.00Not overdue');

  await page.getByRole('button', { name: 'Edit the opening balance of Ravi Painter' }).click();
  const dialog = page.getByRole('dialog', { name: 'Opening balance: Ravi Painter' });
  await dialog.getByRole('textbox', { name: /^Owed on the go-live day/ }).fill('1500');
  await dialog.getByRole('button', { name: 'Use this balance' }).click();
  await expect(table).toContainText('Ravi PainterChanged here₹1,500.00');
  const review = page.getByRole('region', { name: '3. Review and go live' });
  await expect(review).toContainText('Total owed₹46,500.00');
  await expectUsable(page);

  await page.getByRole('button', { name: /^Go live on/ }).click();
  const confirm = page.getByRole('dialog', { name: /^Go live on/ });
  await expect(confirm).toContainText('This cannot be undone');
  await confirm
    .getByRole('checkbox', { name: 'I have checked these opening balances against the old books' })
    .check();
  await confirm.getByRole('button', { name: 'Go live' }).click();
  const live = page.getByRole('region', { name: 'Billing is live' });
  await expect(live).toContainText('Opening balances posted2 customers · ₹46,500.00');
  await expectUsable(page);
});

test('the parties import sets credit limits and days, shown on the customer', async ({ page }) => {
  const business = await createBusiness('Credit Import Paints');
  const phone = uniquePhone();
  await signIn(page, business);
  await page.goto('/imports?kind=parties');
  await page.getByLabel('Spreadsheet', { exact: true }).setInputFiles({
    name: 'parties.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `name,roles,phone,credit_limit,credit_days\r\nApex Builders,customer,${phone},75000,45`,
    ),
  });
  const plan = page.getByRole('table', { name: 'Rows in this file' });
  await expect(plan).toContainText('Apex Builders · credit ₹75,000.00, 45 days');
  await page.getByRole('button', { name: 'Import 1 row' }).click();
  await expect(page.getByText(/Imported: 1 added/)).toBeVisible();

  await page.goto('/parties');
  await page.getByRole('link', { name: 'Apex Builders' }).click();
  await expect(page.getByRole('region', { name: 'Credit' })).toContainText('₹75,000.00');
});

test('the store and go-live screens fit a phone @phone', async ({ page }) => {
  const business = await withOpenings('Phone Setup Paints');
  await signIn(page, business);
  await page.goto('/settings/stores');
  await expect(page.getByRole('region', { name: 'Stores' })).toContainText('HYD · Hyderabad');
  await expectUsable(page);
  await page.getByRole('button', { name: 'New store' }).click();
  await expect(page.getByRole('dialog', { name: 'New store' })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/settings/go-live');
  await expect(page.getByRole('table', { name: 'Opening balances' })).toContainText(
    'Sharma Constructions',
  );
  await expectUsable(page);
  await page
    .getByRole('button', { name: 'Edit the opening balance of Sharma Constructions' })
    .click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectUsable(page);
});
