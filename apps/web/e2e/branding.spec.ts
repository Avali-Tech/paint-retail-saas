import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { SCANNER_ON } from './env.js';
import { PASSWORD, call, createBusiness, finishTwoFactor, signInWithPassword } from './support.js';

// The business's logo and branded sign-in page (/sign-in?b=<slug>). Logo uploads are
// scanned by ClamAV like documents: without E2E_CLAMAV=1 they are refused, and the
// tests check the refusal people see; with it, the whole upload flow runs.

const MAROON = { primary: '#8c1d40', rgb: 'rgb(140, 29, 64)' };

/** A real PNG of one colour, so the browser draws it. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x60)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array<Buffer>(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A business with its own look and sign-in link name, set through the API. */
async function brandedBusiness(name: string, slug: string) {
  const business = await createBusiness(name);
  await call('PUT', '/organization/branding', {
    token: business.token,
    body: {
      appName: name,
      primary: MAROON.primary,
      accent: '#c77700',
      mode: 'light',
      radius: 'large',
      density: 'comfortable',
      font: 'system',
    },
  });
  await call('PUT', '/organization/slug', { token: business.token, body: { slug } });
  return business;
}

const signInButtonColor = (page: Page) =>
  page
    .getByRole('button', { name: 'Sign in' })
    .evaluate((button) => getComputedStyle(button).backgroundColor);

const uniqueSlug = (prefix: string) => `${prefix}-${String(Date.now() % 1_000_000)}`;

async function signInHere(page: Page, phone: string) {
  await page.getByRole('textbox', { name: 'Mobile number or email' }).fill(phone);
  await page.getByLabel('Password', { exact: true }).and(page.locator('input')).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await finishTwoFactor(page, phone);
}

test('a business’s sign-in link shows its name and colours, and the device remembers it', async ({
  page,
}) => {
  const slug = uniqueSlug('maroon');
  const business = await brandedBusiness('Maroon Paints', slug);

  await page.goto(`/sign-in?b=${slug}`);
  await expect(page.getByRole('heading', { name: 'Sign in to Maroon Paints' })).toBeVisible();
  await expect.poll(() => signInButtonColor(page)).toBe(MAROON.rgb);
  await expect(page.getByRole('group', { name: 'Language' })).toBeVisible();
  await expectUsable(page);

  await signInHere(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).first().click();
  // The plain sign-in page now wears the business's look.
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in to Maroon Paints' })).toBeVisible();
  await expect.poll(() => signInButtonColor(page)).toBe(MAROON.rgb);

  // An unknown link says so and keeps the product's own look; the platform console too.
  await page.goto('/sign-in?b=no-such-business-anywhere');
  await expect(page.getByText(/This sign-in link doesn’t match any business/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in to Paint Retail' })).toBeVisible();
  await page.goto('/platform/sign-in');
  await expect.poll(() => signInButtonColor(page)).not.toBe(MAROON.rgb);
});

test('the owner sets the sign-in link name and copies the link', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const business = await createBusiness('Link Name Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/appearance');
  const card = page.getByRole('region', { name: 'Sign-in link' });
  const name = card.getByRole('textbox', { name: 'Link name' });
  await expect(name).toHaveValue(/^link-name-paints(-\d+)?$/);

  await name.fill('platform');
  await card.getByRole('button', { name: 'Save link name' }).click();
  await expect(card.getByText('This name is reserved. Choose another.')).toBeVisible();

  const slug = uniqueSlug('link-name');
  await name.fill(slug);
  await card.getByRole('button', { name: 'Save link name' }).click();
  await expect(page.getByText('Sign-in link saved')).toBeVisible();
  const link = card.getByRole('textbox', { name: 'Your sign-in link' });
  await expect(link).toHaveValue(new RegExp(`/sign-in\\?b=${slug}$`));
  await card.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Link copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await link.inputValue());
});

test('logos are checked before sending, and refused clearly while the virus scanner is off', async ({
  page,
}) => {
  test.skip(SCANNER_ON, 'The scanner is on (E2E_CLAMAV=1)');
  const business = await createBusiness('Scanner-off Logo Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/appearance');
  const card = page.getByRole('region', { name: 'Logo' });
  const file = card.getByLabel(/^Logo file/);
  const upload = card.getByRole('button', { name: 'Upload logo' });

  await file.setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
  });
  await upload.click();
  await expect(card.getByText(/SVG logos are not accepted/)).toBeVisible();

  await file.setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png(120, 40) });
  await upload.click();
  await expect(card.getByText(/The virus scanner is off or not working/)).toBeVisible();
  await expect(card.getByText(/No logo yet/)).toBeVisible();
});

test('the logo shows in the header and on the sign-in page, then is removed', async ({
  page,
  browser,
}) => {
  test.skip(!SCANNER_ON, 'Needs the virus scanner: run with E2E_CLAMAV=1');
  const slug = uniqueSlug('logo');
  const business = await brandedBusiness('Logo Paints', slug);
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/appearance');
  const card = page.getByRole('region', { name: 'Logo' });

  await card.getByLabel(/^Logo file/).setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: png(120, 40),
  });
  await card.getByRole('button', { name: 'Upload logo' }).click();
  await expect(page.getByText('Logo saved')).toBeVisible();
  const header = page.locator('.shell__brand img');
  await expect(header).toBeVisible();
  await expect
    .poll(() => header.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(120);
  await expect(card.getByRole('group', { name: 'How the logo looks' }).locator('img')).toHaveCount(
    2,
  );
  await expect(page.locator('link[data-brand-icon="icon"]')).toHaveAttribute('href', /\/logo\//);

  // Dark mode: the logo sits on a light plate.
  await page.getByRole('combobox', { name: 'Light or dark' }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expectUsable(page);

  // Someone on another device, before signing in.
  const signIn = await (await browser.newContext()).newPage();
  await signIn.goto(`/sign-in?b=${slug}`);
  const logo = signIn.locator('.sign-in__brand img');
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(120);
  await expectUsable(signIn);
  await signIn.close();

  await card.getByRole('button', { name: 'Remove logo' }).click();
  await expect(page.getByText('Logo removed')).toBeVisible();
  await expect(header).toHaveCount(0);
});

test('the branded sign-in page fits a phone @phone', async ({ page }) => {
  const slug = uniqueSlug('phone');
  await brandedBusiness('Phone Branded Paints', slug);
  await page.goto(`/sign-in?b=${slug}`);
  await expect(
    page.getByRole('heading', { name: 'Sign in to Phone Branded Paints' }),
  ).toBeVisible();
  await expect.poll(() => signInButtonColor(page)).toBe(MAROON.rgb);
  await expectUsable(page);
});

test('the logo and sign-in link settings fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Settings Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/appearance');
  await expect(page.getByRole('region', { name: 'Sign-in link' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Logo' })).toBeVisible();
  await expectUsable(page);
});
