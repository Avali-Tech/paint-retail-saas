import { expect, test } from '@playwright/test';
import { call, createBusiness, signInWithPassword } from './support.js';

test('search finds a customer and opens it with the keyboard', async ({ page }) => {
  const business = await createBusiness('Search Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Ramesh Kumar Contractors', roles: ['customer'] },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.keyboard.press('/');
  const search = page.getByRole('combobox', { name: 'Search' });
  await expect(search).toBeFocused();
  await search.fill('ramesh');
  const group = page.getByRole('group', { name: 'Customers & parties' });
  await expect(group.getByRole('option', { name: /Ramesh Kumar Contractors/ })).toBeVisible();
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/parties/${party.id}$`));
});

test('quick actions open from search and with their two-key shortcuts', async ({ page }) => {
  const business = await createBusiness('Shortcut Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.getByRole('combobox', { name: 'Search' }).click();
  const actions = page.getByRole('group', { name: 'Quick actions' });
  await expect(actions.getByRole('option', { name: /\+ Customer\s*N C/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Dashboard', level: 1 }).click();

  await page.keyboard.press('n');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/transfers\/new$/);
  await expect(page.getByRole('heading', { name: 'Request stock', level: 1 })).toBeVisible();
});

test('the notification bell shows what is unread', async ({ page }) => {
  const business = await createBusiness('Bell Paints');
  await signInWithPassword(page, business.ownerPhone);
  const bell = page.getByRole('button', { name: 'Notifications' });
  await expect(bell).toBeVisible();
  await bell.click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toContainText(
    'You are all caught up',
  );
});

test('the dashboard filters to one store @desktop', async ({ page }) => {
  const business = await createBusiness('Filter Paints', [
    ['HYD', 'Hyderabad'],
    ['PUN', 'Pune'],
    ['SEC', 'Secunderabad'],
  ]);
  await signInWithPassword(page, business.ownerPhone);
  const rows = page.getByRole('table', { name: 'Stores' }).getByRole('row');
  await expect(rows).toHaveCount(5);
  await page.getByRole('combobox', { name: 'Store' }).selectOption({ label: 'PUN · Pune' });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toContainText('PUN Pune');
  await expect(page).toHaveURL(/\?store=/);
});

test('phones get a bottom bar with the rest under "More" @phone', async ({ page }) => {
  const business = await createBusiness('Phone Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  const [sidebar, bottomBar] = [
    page.locator('.shell__sidebar'),
    page.locator('.shell__bottom-bar'),
  ];
  await expect(sidebar).toBeHidden();
  await expect(bottomBar.getByRole('link')).toHaveText([
    'Dashboard',
    'Customers',
    'Products',
    'Stock',
  ]);
  await bottomBar.getByRole('button', { name: 'More' }).click();
  const more = page.getByRole('dialog', { name: 'More' });
  await more.getByRole('link', { name: 'Appearance' }).click();
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();
  // Nothing scrolls sideways on a narrow screen.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
