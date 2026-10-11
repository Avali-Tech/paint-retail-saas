import { expect, test, type Locator } from '@playwright/test';
import { expectUsable } from './checks.js';
import { createBusiness, signInWithPassword } from './support.js';

/** What every printed invoice must show (Rule 46), on paper as on screen. */
async function expectKeyFields(invoice: Locator) {
  for (const text of [
    'GSTIN: 36AAKFS4821M1ZR',
    'AMP/26-27/00123',
    '07 Oct 2026',
    'Telangana (36)',
    'Ravi Constructions',
    'Asian Paints Paint Brush',
    '32091090',
    'Round off',
    '₹18,073.00',
    'Rupees Eighteen Thousand Seventy-Three Only',
    'Authorised signatory',
  ]) {
    await expect(invoice.getByText(text).first()).toBeVisible();
  }
}

test('the invoice print preview prints A4 and 80 mm receipts in the business’s name', async ({
  page,
}) => {
  const business = await createBusiness('Print Preview Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  const appName = (await page.locator('.shell__app-name').textContent()) ?? '';

  await page.goto('/print-preview');
  await expect(
    page.getByRole('heading', { name: 'Invoice print preview', level: 1 }),
  ).toBeVisible();
  const a4 = page.getByRole('article', { name: 'Tax Invoice AMP/26-27/00123' });
  await expect(a4.locator('.invoice__business')).toHaveText(appName);
  await expectKeyFields(a4);
  await expectUsable(page);

  // On paper: only the invoice, with its running header for later pages.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.shell__header')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Print' })).toBeHidden();
  await expect(page.getByRole('form', { name: 'Preview options' })).toBeHidden();
  await expectKeyFields(a4);
  await expect(a4.getByText('ORIGINAL FOR RECIPIENT')).toBeVisible();
  await expect(a4.locator('.invoice__running')).toBeVisible();

  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('combobox', { name: 'Paper' }).selectOption('Thermal 80 mm');
  await page
    .getByRole('combobox', { name: 'Second language on the invoice' })
    .selectOption('తెలుగు');
  const receipt = page.getByRole('article', { name: 'Tax Invoice AMP/26-27/00123' });
  await expect(receipt).toHaveClass(/invoice--thermal/);
  await expect(receipt.getByText('ట్యాక్స్ ఇన్‌వాయిస్')).toBeVisible();
  await expectUsable(page);

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.shell__header')).toBeHidden();
  await expectKeyFields(receipt);
  await expect(receipt.getByText('HSN 32091090 · GST 18%').first()).toBeVisible();
  // 80 mm wide on paper (72 mm printable plus its margins).
  const width = await receipt.evaluate((element) => element.getBoundingClientRect().width);
  expect(Math.round(width)).toBe(Math.round((80 / 25.4) * 96));
});
