import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, signInWithPassword } from './support.js';

// Valid GSTINs (GSTN check character) of one PAN in Telangana (36) and Andhra Pradesh (37).
const TELANGANA_GSTIN = '36AABCS1429B1ZV';

test('Tax & GST: register a store, add a rate, and give a product its HSN and tax category', async ({
  page,
}) => {
  const business = await createBusiness('Tax Paints');
  await call('POST', '/brands', { token: business.token, body: { name: 'Asian Paints' } });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/settings/tax');
  await expect(page.getByRole('heading', { name: 'Tax & GST', level: 1 })).toBeVisible();
  const profileCard = page.getByRole('region', { name: 'Business' });
  await profileCard.getByRole('textbox', { name: 'Legal name' }).fill('Tax Paints Private Limited');
  await profileCard.getByRole('button', { name: 'Save legal name' }).click();
  await expect(page.getByText('Legal name saved')).toBeVisible();

  const registrations = page.getByRole('region', { name: 'GST registrations' });
  await registrations
    .getByRole('button', { name: 'Edit the GST registration of Hyderabad' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'GST registration: HYD · Hyderabad' });
  await dialog.getByRole('combobox', { name: 'Registration type' }).selectOption('regular');
  await dialog.getByRole('combobox', { name: 'State' }).selectOption('36');
  await dialog.getByRole('textbox', { name: 'GSTIN' }).fill(TELANGANA_GSTIN);
  await dialog.getByRole('textbox', { name: 'PIN code' }).fill('500016');
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Save registration' }).click();
  await expect(dialog).toBeHidden();
  await expect(registrations).toContainText(`36 · Telangana · ${TELANGANA_GSTIN}`);
  await expect(profileCard.getByRole('textbox', { name: 'PAN' })).toHaveValue('AABCS1429B');

  // A rate change is a new rate from a date; the past stays as it was.
  const categories = page.getByRole('region', { name: 'Tax categories' });
  await categories
    .getByRole('group', { name: 'Actions for Putty & fillers 18%' })
    .getByRole('button', { name: 'New rate' })
    .click();
  const rate = page.getByRole('dialog', { name: 'New rate for Putty & fillers 18%' });
  await rate.getByRole('textbox', { name: 'GST rate (%)' }).fill('12');
  await rate.getByLabel('Starts on').fill('2099-04-01');
  await rate.getByRole('button', { name: 'Save' }).click();
  await expect(rate).toBeHidden();
  await expect(
    categories.getByRole('list', { name: 'Rates of Putty & fillers 18%' }),
  ).toContainText('12% · From 1 Apr 2099');
  await expectUsable(page);

  // Registered: a new product needs its tax category.
  await page.goto('/products/new');
  await page.getByRole('combobox', { name: 'Brand' }).selectOption({ label: 'Asian Paints' });
  await page.getByRole('textbox', { name: 'Name' }).fill('Trucare Wall Putty');
  await page.getByRole('combobox', { name: 'Type' }).selectOption({ label: 'Putty' });
  await page.getByRole('textbox', { name: 'HSN code' }).fill('3214');
  const pack = page.getByRole('group', { name: 'Size / pack 1' });
  await pack.getByRole('textbox', { name: 'SKU' }).fill('TWP-20KG');
  await pack.getByRole('textbox', { name: 'Size' }).fill('20');
  await pack.getByRole('combobox', { name: 'Unit' }).selectOption('kg');
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(
    page.getByText('Choose a tax category: the business is registered for GST'),
  ).toBeVisible();
  await page
    .getByRole('combobox', { name: 'Tax category' })
    .selectOption({ label: 'Putty & fillers 18%' });
  await expect(page.getByText('GST 18% today')).toBeVisible();
  await page.getByRole('button', { name: 'Add product' }).click();
  await expect(page.getByRole('heading', { name: 'Trucare Wall Putty', level: 1 })).toBeVisible();
  await expect(page.getByText('Tax category: Putty & fillers 18%')).toBeVisible();

  await page.goto('/products');
  await expect(page.getByRole('table', { name: 'Products' })).toContainText(
    '3214 · Putty & fillers 18%',
  );
});

test('the Tax & GST settings and the product form fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Tax Paints');
  await call('PUT', '/gst-registrations/business', {
    token: business.token,
    body: { legalName: 'Phone Tax Paints LLP' },
  });
  const [store] = business.stores;
  await call('PUT', `/gst-registrations/stores/${String(store?.id)}`, {
    token: business.token,
    body: { registrationType: 'regular', stateCode: '36', gstin: TELANGANA_GSTIN },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/settings/tax');
  await expect(page.getByRole('region', { name: 'GST registrations' })).toContainText(
    TELANGANA_GSTIN,
  );
  await expect(page.getByText('GST 18% today').first()).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Edit the GST registration of Pune' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/products/new');
  await expect(page.getByRole('combobox', { name: /Tax category/ })).toBeVisible();
  await expectUsable(page);
});
