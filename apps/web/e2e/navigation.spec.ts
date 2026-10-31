import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import {
  PASSWORD,
  addMember,
  call,
  createBusiness,
  openFromMenu,
  signInWithPassword,
  uniquePhone,
} from './support.js';

// The grouped menu (docs/mvp-3/navigation-ux.md §5): a short list of sections,
// each page a tab, every address unchanged.

const sidebar = (page: Page) => page.locator('.shell__sidebar');
/** The menu entries, without the member's own account security. */
const entries = (page: Page) =>
  sidebar(page).locator('.shell__menu a, .shell__account a').filter({
    hasNotText: 'Account security',
  });

/** Signs in as a new member of `business` with a standard role. */
async function signInAs(page: Page, roleKey: string, fullName: string) {
  const business = await createBusiness(`${fullName} Paints`);
  const phone = uniquePhone();
  await addMember(business, roleKey, { fullName, phone, password: PASSWORD });
  await signInWithPassword(page, phone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
}

test('an owner sees a short menu of sections, nine at most', async ({ page }) => {
  const business = await createBusiness('Menu Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(entries(page)).toHaveText([
    /New sale/,
    'Home',
    'Sales',
    'Customers',
    'Money',
    'Stock',
    'Buy',
    'Reports',
    'Settings',
  ]);
  expect(await entries(page).count()).toBeLessThanOrEqual(9);
  await expect(sidebar(page).getByRole('link', { name: 'New sale' })).toHaveAttribute(
    'href',
    '/pos',
  );
  await expect(sidebar(page).getByRole('link', { name: 'Home' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expectUsable(page);
});

test('a sales executive sees only the sections for selling', async ({ page }) => {
  await signInAs(page, 'sales_executive', 'Ravi Sales');
  await expect(entries(page)).toHaveText([
    /New sale/,
    'Home',
    'Sales',
    'Customers',
    'Money',
    'Stock',
    'Reports',
    'Settings',
  ]);
  await openFromMenu(page, 'Money');
  await expect(
    page.getByRole('navigation', { name: 'Money', exact: true }).getByRole('link'),
  ).toHaveText(['Receivables', 'Collections', 'Payments', 'Payment links']);
});

test('an inventory manager has stock and buying, and no Sales', async ({ page }) => {
  await signInAs(page, 'inventory_manager', 'Imran Stores');
  await expect(entries(page)).toHaveText([
    'Home',
    'Customers',
    'Stock',
    'Buy',
    'Reports',
    'Settings',
  ]);
  await expect(sidebar(page).getByRole('link', { name: 'Sales', exact: true })).toHaveCount(0);
});

test('a link deep inside a section lights that section and tab', async ({ page }) => {
  const business = await createBusiness('Deep Link Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Apex Builders', roles: ['customer'] },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto(`/parties/${party.id}`);
  await expect(page.getByRole('heading', { name: 'Apex Builders', level: 1 })).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: 'Customers', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(
    page
      .getByRole('navigation', { name: 'Customers', exact: true })
      .getByRole('link', { name: 'Customers', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  await page.goto('/brand-schemes/price-hike');
  await expect(sidebar(page).getByRole('link', { name: 'Buy', exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(
    page
      .getByRole('navigation', { name: 'Buy', exact: true })
      .getByRole('link', { name: 'Price-hike planner' }),
  ).toHaveAttribute('aria-current', 'page');
  await expectUsable(page);
});

test('a section reopens at the tab used last, also after a reload', async ({ page }) => {
  const business = await createBusiness('Memory Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await openFromMenu(page, 'Stock');
  await expect(page).toHaveURL(/\/products$/);
  await openFromMenu(page, 'Stock', 'Low stock');
  await expect(page).toHaveURL(/\/stock\/low$/);
  await openFromMenu(page, 'Sales');
  await expect(page).toHaveURL(/\/quotations$/);
  await openFromMenu(page, 'Stock');
  await expect(page).toHaveURL(/\/stock\/low$/);

  await page.reload();
  await openFromMenu(page, 'Sales');
  await openFromMenu(page, 'Stock');
  await expect(page).toHaveURL(/\/stock\/low$/);
});

test('the settings are one page, each with the way back @desktop', async ({ page }) => {
  const business = await createBusiness('Settings Paints');
  await signInWithPassword(page, business.ownerPhone);
  await openFromMenu(page, 'Settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expectUsable(page);
  await openFromMenu(page, 'Settings', 'Tax & GST');
  await expect(page).toHaveURL(/\/settings\/tax$/);
  await page.getByRole('link', { name: '← All settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test('phones get Home, New sale, Customers and Stock, the rest under "More" @phone', async ({
  page,
}) => {
  await signInAs(page, 'crm_executive', 'Kiran Crm');
  const bottomBar = page.locator('.shell__bottom-bar');
  // No counter sale for this role: the next section fills the gap.
  await expect(bottomBar.getByRole('link')).toHaveText(['Home', 'Customers', 'Stock', 'Reports']);
  await bottomBar.getByRole('button', { name: 'More' }).click();
  const more = page.getByRole('dialog', { name: 'More' });
  await expect(more.getByRole('link')).toHaveText(['Settings', 'Account security']);
  await page.keyboard.press('Escape');

  // Many tabs scroll inside their bar, not the page, and the current one is in view.
  await bottomBar.getByRole('link', { name: 'Customers' }).click();
  const tabs = page.getByRole('navigation', { name: 'Customers', exact: true });
  await tabs.getByRole('link', { name: 'Credit requests' }).click();
  await expect(page).toHaveURL(/\/credit-requests$/);
  await expect(tabs.getByRole('link', { name: 'Credit requests' })).toBeInViewport();
  await expectUsable(page);
});
