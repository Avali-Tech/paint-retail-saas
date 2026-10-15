import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import {
  PASSWORD,
  addMember,
  call,
  createBusiness,
  signInWithPassword,
  uniquePhone,
} from './support.js';

test('a branch manager asks for credit, the owner approves it, holds and releases it', async ({
  browser,
}) => {
  // A whole working day in one test: give it more than the default 30 s.
  test.setTimeout(90_000);
  const business = await createBusiness('Credit Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Apex Builders', roles: ['customer'] },
  });
  const managerPhone = uniquePhone();
  await addMember(business, 'branch_manager', {
    fullName: 'Meena Manager',
    phone: managerPhone,
    password: PASSWORD,
  });

  // The branch manager asks for ₹1,00,000 for 45 days.
  const manager = await (await browser.newContext()).newPage();
  await signInWithPassword(manager, managerPhone);
  await expect(manager.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await manager.goto(`/parties/${party.id}`);
  const credit = manager.getByRole('region', { name: 'Credit' });
  await expect(credit).toContainText('No credit');
  await credit.getByRole('button', { name: 'Request credit' }).click();
  const ask = manager.getByRole('dialog', { name: 'Request a credit limit' });
  await ask.getByRole('textbox', { name: 'Limit (₹)' }).fill('100000');
  await ask.getByRole('textbox', { name: 'Days to pay' }).fill('45');
  await ask.getByRole('textbox', { name: 'Why this customer should get it' }).fill('Big order');
  await expectUsable(manager);
  await ask.getByRole('button', { name: 'Send for approval' }).click();
  await expect(manager.getByText('Credit request sent for approval')).toBeVisible();
  await expect(credit).toContainText('is waiting for approval: ₹1,00,000.00 for 45 days');
  await expect(credit.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  // The request has its own page, where its notifications lead.
  await credit.getByRole('link', { name: /is waiting for approval/ }).click();
  await expect(
    manager.getByRole('heading', { name: /^CR-\d+ · Credit request$/, level: 1 }),
  ).toBeVisible();
  await expect(manager.getByRole('region', { name: 'Details' })).toContainText('Big order');
  await expectUsable(manager);
  await manager.goBack();

  // The owner decides from the list of waiting requests.
  const owner = await (await browser.newContext()).newPage();
  await signInWithPassword(owner, business.ownerPhone);
  await expect(owner.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await owner.goto('/credit-requests');
  const table = owner.getByRole('table', { name: 'Credit requests' });
  await expect(table).toContainText('Apex Builders');
  await expect(table).toContainText('Meena Manager');
  await expectUsable(owner);
  await table.getByRole('button', { name: /^Approve CR-/ }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Approve' }).click();
  await expect(owner.getByText('Credit approved')).toBeVisible();
  await expect(owner.getByText('No credit requests here')).toBeVisible();

  // The limit is in force: the manager puts it on hold, only the owner releases it.
  await manager.reload();
  await expect(credit).toContainText('₹1,00,000.00');
  await expect(credit).toContainText('Allowed');

  // Until billing exists, the manager enters what the customer owes: ₹90,000 is 90% of the limit.
  await credit.getByRole('button', { name: 'Update balance' }).click();
  const balance = manager.getByRole('dialog', { name: 'What the customer owes' });
  await balance.getByRole('textbox', { name: 'Owes now (₹)' }).fill('90000');
  await balance.getByRole('combobox', { name: 'Risk' }).selectOption('medium');
  await expectUsable(manager);
  await balance.getByRole('button', { name: 'Save' }).click();
  await expect(manager.getByText('Balance updated')).toBeVisible();
  await expect(credit).toContainText('Needs manager approval');
  await expect(credit).toContainText('₹10,000.00');

  await credit.getByRole('button', { name: 'Put on hold' }).click();
  await manager.getByRole('dialog').getByRole('textbox', { name: 'Reason' }).fill('Cheque bounced');
  await manager.getByRole('dialog').getByRole('button', { name: 'Put on hold' }).click();
  await expect(credit).toContainText('Blocked: Credit is on hold');
  await expect(credit.getByRole('button', { name: 'Release hold' })).toHaveCount(0);

  await owner.goto(`/parties/${party.id}`);
  const ownerCredit = owner.getByRole('region', { name: 'Credit' });
  await ownerCredit.getByRole('button', { name: 'Release hold' }).click();
  const release = owner.getByRole('dialog', { name: 'Release the credit hold' });
  await release.getByRole('textbox', { name: 'Reason (optional)' }).fill('Cheque cleared');
  await release.getByRole('button', { name: 'Release hold' }).click();
  await expect(owner.getByText('Credit released')).toBeVisible();
  await expect(ownerCredit).toContainText('Needs manager approval');
  await expectUsable(owner);
});

test('the owner sets the credit rules', async ({ page }) => {
  const business = await createBusiness('Rules Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Credit rules' })
    .click();
  const normal = page.getByRole('textbox', { name: 'Sell normally up to (% of limit)' });
  await expect(normal).toHaveValue('80');
  await normal.fill('120');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(
    page.getByText('Manager approval must start at or above the normal limit'),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Manager approves up to (% of limit)' }).fill('150');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await expect(page.getByText('Credit rules saved')).toBeVisible();
  await expectUsable(page);
  await page.reload();
  await expect(normal).toHaveValue('120');
});

test('"+ Credit request" finds the customer and sends the request (N K)', async ({ page }) => {
  const business = await createBusiness('Quick Credit Paints');
  await call('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Apex Builders', roles: ['customer'] },
  });
  await signInWithPassword(page, business.ownerPhone);
  await page.getByRole('heading', { name: 'Dashboard', level: 1 }).click();
  await page.keyboard.press('n');
  await page.keyboard.press('k');
  await expect(page).toHaveURL(/\/credit-requests\/new$/);
  await page.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill('apex');
  await page.getByRole('button', { name: 'Choose Apex Builders' }).click();
  await page.getByRole('textbox', { name: 'Limit (₹)' }).fill('75000');
  await page.getByRole('textbox', { name: 'Days to pay' }).fill('30');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(
    page.getByRole('heading', { name: /^CR-\d+ · Credit request$/, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Details' })).toContainText('₹75,000.00 · 30 days');
});

test('credit requests and the credit panel fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Credit Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Sri Venkateswara Builders and Developers', roles: ['customer'] },
  });
  await call('POST', '/credit-requests', {
    token: business.token,
    body: { partyId: party.id, limitPaise: 2_50_000_00, creditDays: 30, note: 'Repeat buyer' },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/credit-requests');
  await expect(page.getByRole('table', { name: 'Credit requests' })).toContainText(
    'Sri Venkateswara',
  );
  await expectUsable(page);
  await page.goto(`/parties/${party.id}`);
  const credit = page.getByRole('region', { name: 'Credit' });
  await expect(credit).toContainText('is waiting for approval');
  await expectUsable(page);
  await credit.getByRole('button', { name: /^Approve CR-/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectUsable(page);
  await page.goto('/settings/credit');
  await expect(page.getByRole('textbox', { name: 'Sell normally up to (% of limit)' })).toHaveValue(
    '80',
  );
  await expectUsable(page);
  await page.goto('/credit-requests/new');
  await page.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill('venkat');
  await expect(
    page.getByRole('button', { name: 'Choose Sri Venkateswara Builders and Developers' }),
  ).toBeVisible();
  await expectUsable(page);
});
