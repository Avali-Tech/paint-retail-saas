import { expect, test } from '@playwright/test';
import {
  PASSWORD,
  addMember,
  call,
  createBusiness,
  lastCodeFor,
  signInWithPassword,
  storedToken,
  submitPassword,
  uniquePhone,
} from './support.js';

test('an owner signs in with a password, sees the dashboard and signs out', async ({ page }) => {
  const business = await createBusiness('Sri Balaji Paints');
  await signInWithPassword(page, business.ownerPhone);

  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.locator('.shell__business')).toHaveText('Sri Balaji Paints');
  const stores = page.getByRole('table', { name: 'Stores' });
  await expect(stores.getByRole('row')).toHaveText([
    /^Store/,
    /HYD Hyderabad₹0\.00/,
    /PUN Pune₹0\.00/,
    /^Total/,
  ]);

  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Sign out' })
    .click();
  await expect(page.getByText('You have signed out.')).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  // The session is gone on the server too.
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
});

test('wrong details are refused with the API’s message', async ({ page }) => {
  const business = await createBusiness('Ravi Hardware');
  await submitPassword(page, business.ownerPhone, 'not-the-password');
  await expect(page.getByRole('alert')).toHaveText('Invalid sign-in details');
});

test('a person in two businesses chooses which one to open', async ({ page }) => {
  const first = await createBusiness('ABC Paints');
  const second = await createBusiness('XYZ Colours');
  // XYZ hires ABC's owner; they keep their own password.
  await addMember(second, 'branch_manager', { fullName: 'Anil Owner', phone: first.ownerPhone });

  await submitPassword(page, first.ownerPhone);
  const chooser = page.getByRole('dialog', { name: 'Choose a business' });
  await expect(chooser).toBeVisible();
  await chooser.getByRole('button', { name: 'XYZ Colours' }).click();
  await expect(page.locator('.shell__business')).toHaveText('XYZ Colours');
  // A branch manager does not get the owner-only appearance settings.
  await expect(
    page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Appearance' }),
  ).toHaveCount(0);
});

test('counter staff sign in with a code texted to their mobile', async ({ page }) => {
  const business = await createBusiness('Lakshmi Paints');
  const phone = uniquePhone();
  await addMember(business, 'store_employee', { fullName: 'Suresh Counter', phone });

  await page.goto('/sign-in');
  await page.getByRole('tab', { name: 'Mobile code' }).click();
  await page.getByRole('textbox', { name: 'Mobile number' }).fill(phone.slice(3));
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByText(`Enter the code sent to ${phone.slice(3)}`)).toBeVisible();
  await page.getByRole('textbox', { name: '6-digit code' }).fill(await lastCodeFor(phone));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(page.getByText('Signed in as Suresh Counter · Store Employee')).toBeVisible();
  // Their role sees stock but not purchasing or leads.
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link')).toHaveText([
    'Dashboard',
    'Customers',
    'Products',
    'Stock',
    'Invoices',
    'Credit & debit notes',
    'Follow-ups',
    'Documents',
    'Reports',
    'Account security',
  ]);
});

test('an ended session sends the user back to sign in', async ({ page }) => {
  const business = await createBusiness('Ganesh Paints');
  await signInWithPassword(page, business.ownerPhone, PASSWORD);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  // Loaded, so no request from signing in is still on its way when the session ends.
  await expect(page.getByRole('table', { name: 'Stores' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();

  // The session ends elsewhere (signed out on another device, or expired).
  await call('POST', '/auth/logout', { token: await storedToken(page) });
  // Its next request (here a reload) finds out. Clicking a button raced the app's own
  // background requests (branding, notifications), which may find out first.
  await page.reload();

  await expect(page.getByText('Your session has ended. Please sign in again.')).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});
