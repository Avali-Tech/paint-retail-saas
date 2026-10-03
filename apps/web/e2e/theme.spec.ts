import { expect, test, type Page } from '@playwright/test';
import { accessibilityProblems, createBusiness, signInWithPassword } from './support.js';

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
