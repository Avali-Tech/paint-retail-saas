import { expect, test, type Page } from '@playwright/test';
import {
  PASSWORD,
  accessibilityProblems,
  addMember,
  createBusiness,
  signInWithPassword,
  uniquePhone,
} from './support.js';

const primaryButtonColor = (page: Page) =>
  page
    .getByRole('button', { name: 'Primary action' })
    .evaluate((button) => getComputedStyle(button).backgroundColor);

test('the owner rebrands the whole app live, and it stays after a reload', async ({ page }) => {
  const business = await createBusiness('Brand Paints');
  await signInWithPassword(page, business.ownerPhone);
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Appearance' })
    .click();
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();
  await expect.poll(() => primaryButtonColor(page)).toBe('rgb(29, 78, 216)');

  await page.getByRole('textbox', { name: 'App name' }).fill('Sri Balaji Paints');
  await page.getByRole('textbox', { name: 'Primary colour', exact: true }).fill('#15803d');
  // No reload: the header, buttons and page title follow at once.
  await expect.poll(() => primaryButtonColor(page)).toBe('rgb(21, 128, 61)');
  await expect(page.locator('.shell__app-name')).toHaveText('Sri Balaji Paints');
  await expect(page).toHaveTitle('Sri Balaji Paints');

  await page.getByRole('combobox', { name: 'Light or dark' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.getByText('Appearance saved')).toBeVisible();

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.shell__app-name')).toHaveText('Sri Balaji Paints');
  expect(await accessibilityProblems(page)).toEqual([]);
});

test('a theme one member saves is what everyone else in the business sees', async ({ browser }) => {
  const business = await createBusiness('Shared Brand Paints');
  const adminPhone = uniquePhone();
  await addMember(business, 'org_admin', {
    fullName: 'Asha Admin',
    phone: adminPhone,
    password: PASSWORD,
  });

  const owner = await (await browser.newContext()).newPage();
  await signInWithPassword(owner, business.ownerPhone);
  await expect(owner.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await owner.goto('/settings/appearance');
  await owner.getByRole('textbox', { name: 'App name' }).fill('Sri Balaji Paints');
  await owner.getByRole('textbox', { name: 'Primary colour', exact: true }).fill('#15803d');
  await owner.getByRole('button', { name: 'Save appearance' }).click();
  await expect(owner.getByText('Saved for everyone in your business')).toBeVisible();

  // Another person, on another device that has never seen this brand.
  const admin = await (await browser.newContext()).newPage();
  await signInWithPassword(admin, adminPhone);
  await expect(admin.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await expect(admin.locator('.shell__app-name')).toHaveText('Sri Balaji Paints');
  await expect(admin).toHaveTitle('Sri Balaji Paints');
  await admin.goto('/settings/appearance');
  await expect.poll(() => primaryButtonColor(admin)).toBe('rgb(21, 128, 61)');
  await expect(admin.getByRole('textbox', { name: 'App name' })).toHaveValue('Sri Balaji Paints');
});

test('a hard-to-read brand colour is adjusted so the app stays readable (WCAG AA)', async ({
  page,
}) => {
  const business = await createBusiness('Gold Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/appearance');
  await page.getByRole('textbox', { name: 'Primary colour', exact: true }).fill('#ffd700');
  await expect(
    page.getByText('Primary was darkened in light mode so buttons stand out from the page (3:1).'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save appearance' }).click();
  // The server answers with the adjustments it made to keep the saved theme readable.
  await expect(
    page.getByText('To keep everything readable, the saved theme adjusts:'),
  ).toBeVisible();
  await page.goto('/dashboard');
  await expect(page.getByRole('table', { name: 'Stores' })).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);
});

test('sign-in and the dashboard meet WCAG AA', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);

  const business = await createBusiness('Access Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('table', { name: 'Stores' })).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);
});

test('the app is installable: manifest, icons and a service worker', async ({ page, request }) => {
  const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
    icons: { src: string }[];
  };
  expect(manifest).toMatchObject({ name: 'Paint Retail', display: 'standalone', start_url: '/' });
  for (const icon of manifest.icons) {
    expect((await request.get(icon.src)).ok()).toBe(true);
  }
  await page.goto('/sign-in');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(scope).toMatch(/\/$/);
});
