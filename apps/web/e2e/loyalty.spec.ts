import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, signInWithPassword } from './support.js';

test('the owner sets up loyalty, enrols a painter and works with points', async ({ page }) => {
  // A whole working day in one test: give it more than the default 30 s.
  test.setTimeout(90_000);
  const business = await createBusiness('Loyal Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Ravi Painter', roles: ['painter'] },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  // 2 points per ₹100 and a Silver tier from 1,000 points.
  await page.goto('/settings/loyalty');
  await page.getByRole('textbox', { name: 'Points earned' }).fill('2');
  await page.getByRole('button', { name: 'Add tier' }).click();
  await page.getByRole('textbox', { name: 'Tier 1 name' }).fill('Silver');
  await page.getByRole('textbox', { name: 'Tier 1 from points' }).fill('1000');
  await page.getByRole('textbox', { name: 'Minimum points to redeem' }).fill('100');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save programme' }).click();
  await expect(page.getByText('Loyalty programme saved')).toBeVisible();

  await page.goto(`/parties/${party.id}`);
  const loyalty = page.getByRole('region', { name: 'Loyalty points' });
  await expect(loyalty).toContainText('Not in the loyalty programme yet.');
  await loyalty.getByRole('button', { name: 'Enrol in loyalty' }).click();
  const enrol = page.getByRole('dialog', { name: 'Enrol in the loyalty programme' });
  await enrol
    .getByRole('combobox', { name: 'Looked after by' })
    .selectOption({ label: 'Anil Owner · Owner' });
  await expectUsable(page);
  await enrol.getByRole('button', { name: 'Enrol' }).click();
  await expect(page.getByText('Enrolled in the loyalty programme')).toBeVisible();
  await expect(loyalty).toContainText('Anil Owner');

  // ₹60,000 of paint earns 1,200 points and reaches Silver.
  await loyalty.getByRole('button', { name: 'Record purchase' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Purchase amount (₹)' }).fill('60000');
  await dialog.getByRole('textbox', { name: 'Bill or invoice number' }).fill('INV-104');
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(loyalty).toContainText('1,200 points');
  await expect(loyalty).toContainText('Silver');

  await loyalty.getByRole('button', { name: 'Award points' }).click();
  await dialog.getByRole('textbox', { name: 'Points' }).fill('300');
  await dialog.getByRole('textbox', { name: 'Campaign (optional)' }).fill('Diwali');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(loyalty).toContainText('1,500 points');

  await loyalty.getByRole('button', { name: 'Redeem points' }).click();
  await dialog.getByRole('textbox', { name: 'Points' }).fill('50');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toContainText('Redeem at least 100 points');
  await dialog.getByRole('textbox', { name: 'Points' }).fill('500');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(loyalty).toContainText('1,000 points');

  await loyalty.getByRole('button', { name: 'Adjust points' }).click();
  await dialog.getByRole('textbox', { name: 'Points' }).fill('-20');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Counted twice');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(loyalty).toContainText('980 points');

  const history = loyalty.getByRole('table', { name: 'Points history' });
  await expect(history.getByRole('row')).toHaveCount(5);
  await expect(history.getByRole('row').nth(1)).toContainText('Counted twice');
  await expect(history).toContainText('INV-104');
  await expect(history).toContainText('Diwali');
  await expectUsable(page);

  await loyalty.getByRole('button', { name: 'Close account' }).click();
  await expect(page.getByText('Loyalty account closed')).toBeVisible();
  await expect(loyalty.getByRole('button', { name: 'Award points' })).toHaveCount(0);
  await loyalty.getByRole('button', { name: 'Reopen account' }).click();
  await expect(page.getByText('Loyalty account reopened')).toBeVisible();
  await expect(loyalty.getByRole('button', { name: 'Award points' })).toBeVisible();
});

test('the points history fits a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Loyal Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Mohammed Irfan Painting Works', roles: ['painter'] },
  });
  const base = `/parties/${party.id}/loyalty`;
  await call('POST', base, { token: business.token, body: {} });
  await call('POST', `${base}/purchases`, {
    token: business.token,
    body: { manualPurchasePaise: 1_25_000_00, reference: 'INV-2026-000123', note: 'Exterior job' },
  });
  await call('POST', `${base}/awards`, {
    token: business.token,
    body: { points: 250, campaign: 'Diwali dhamaka' },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto(`/parties/${party.id}`);
  const loyalty = page.getByRole('region', { name: 'Loyalty points' });
  await expect(loyalty.getByRole('table', { name: 'Points history' }).getByRole('row')).toHaveCount(
    3,
  );
  await expectUsable(page);
  await loyalty.getByRole('button', { name: 'Record purchase' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectUsable(page);
  await page.goto('/settings/loyalty');
  await page.getByRole('button', { name: 'Add tier' }).click();
  await expect(page.getByRole('textbox', { name: 'Tier 1 name' })).toBeVisible();
  await expectUsable(page);
});
