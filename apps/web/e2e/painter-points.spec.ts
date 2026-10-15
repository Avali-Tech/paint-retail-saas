import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, uniquePhone } from './support.js';

// Painter points from invoices (P2-M36, MVP 3 spec §7 Round 2 demo): the owner sets
// an earn rule, and a homeowner's invoice tagged with a painter credits the painter.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

test('the owner sets an earn rule and a tagged invoice credits the painter', async ({ page }) => {
  test.setTimeout(90_000);
  const business = await createBusiness('Painter Points Paints', [['AMP', 'Ameerpet']]);
  const { token } = business;
  const storeId = String(business.stores[0]?.id);
  await call('PUT', '/gst-registrations/business', { token, body: { legalName: 'Points LLP' } });
  await call('PUT', `/gst-registrations/stores/${storeId}`, {
    token,
    body: { registrationType: 'regular', stateCode: '36', gstin: TELANGANA_GSTIN },
  });
  const { categories } = await call<{ categories: { id: string; key: string | null }[] }>(
    'GET',
    '/tax-categories/options',
    { token },
  );
  const brand = await call<{ id: string }>('POST', '/brands', {
    token,
    body: { name: 'Asian Paints' },
  });
  const paint = await call<{ variants: { id: string }[] }>('POST', '/products', {
    token,
    body: {
      brandId: brand.id,
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '3209',
      taxCategoryId: categories.find((option) => option.key === 'paints')?.id,
      variants: [
        { sku: 'APX-20L', packSize: 20, unit: 'l', sellingPricePaise: 5_900_00, barcodes: [] },
      ],
    },
  });
  const variantId = String(paint.variants[0]?.id);
  await openingStock(business, storeId, [{ variantId, quantity: 10, unitCostPaise: 4_000_00 }]);
  const party = (displayName: string, roles: string[]) =>
    call<{ id: string }>('POST', '/parties', {
      token,
      body: { displayName, phone: uniquePhone(), roles },
    });
  const homeowner = await party('Suresh Reddy', ['customer']);
  const painter = await party('Ravi the painter', ['painter']);
  await call('POST', `/parties/${painter.id}/loyalty`, { token, body: {} });
  // Invoices earn points once billing is live (spec §4.7).
  await call('POST', '/sales/go-live', { token, body: {} });

  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/painter-points');
  await expect(page.getByRole('heading', { name: 'Painter points rules', level: 1 })).toBeVisible();
  await expect(page.getByText('No rules yet, so tagged painters earn no points.')).toBeVisible();
  await expectUsable(page);

  // Double points on Asian Paints: 2 points for every ₹100 of taxable value.
  await page.getByRole('button', { name: 'Add rule' }).click();
  const dialog = page.getByRole('dialog', { name: 'New earn rule' });
  await dialog.getByRole('textbox', { name: 'Rule name' }).fill('Asian double');
  await dialog.getByRole('combobox', { name: 'Brand' }).selectOption({ label: 'Asian Paints' });
  await dialog.getByRole('textbox', { name: 'Multiplier' }).fill('2');
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Earn rule saved')).toBeVisible();
  const rules = page.getByRole('table', { name: 'Painter points rules' });
  await expect(rules.getByRole('row').nth(1)).toContainText('Asian double');
  await expect(rules.getByRole('row').nth(1)).toContainText('× 2');
  await expectUsable(page);

  // Two 20 L packs: ₹10,000 taxable, paid in cash, brought in by the painter.
  const modes = await call<{ id: string; kind: string }[]>('GET', '/payment-modes', { token });
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: {
      storeId,
      partyId: homeowner.id,
      influencerPartyId: painter.id,
      lines: [{ variantId, quantity: 2 }],
    },
  });
  const invoice = await call<{ number: string }>('POST', `/invoices/${draft.id}/issue`, {
    token,
    body: {
      payments: [{ modeId: modes.find((m) => m.kind === 'cash')?.id, amountPaise: 11_800_00 }],
    },
  });

  await page.goto(`/parties/${painter.id}`);
  const loyalty = page.getByRole('region', { name: 'Loyalty points' });
  await expect(loyalty).toContainText('200 points');
  await expect(loyalty).toContainText('200 (200 earned, 0 taken back)');
  const history = loyalty.getByRole('table', { name: 'Points history' });
  await expect(history.getByRole('row').nth(1)).toContainText('Painter points');
  await expect(history.getByRole('row').nth(1)).toContainText(invoice.number);
  await expectUsable(page);
});

test('the earn rules fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Points Paints');
  await call('POST', '/loyalty-earn-rules', {
    token: business.token,
    body: {
      name: 'Every brand, every rupee',
      basis: 'value',
      points: 1,
      perPaise: 10_000,
      perMillilitres: null,
      brandId: null,
      multiplierBps: 15_000,
      validFrom: '2026-01-01',
      validUntil: '2027-12-31',
      isActive: true,
    },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/settings/painter-points');
  await expect(page.getByRole('table', { name: 'Painter points rules' })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Edit Every brand, every rupee' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit earn rule' })).toBeVisible();
  await expectUsable(page);
});
