import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { API_URL } from './env.js';
import { createProduct, createSupplier } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

// Brand statement reconciliation (P2-M34): a template made in the screens, a month's
// statement uploaded and checked, then reconciled: an amount difference, a missing GRN,
// a scheme credit note recorded from its line, and members' matches and explanations.

/** An India date `days` from today, as YYYY-MM-DD and as the statement writes it. */
const indiaDay = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/**
 * A brand bought from its distributor: two GRNs received today (₹40,000 and ₹10,000
 * before GST) and a running scheme of the brand.
 */
async function bought(business: Business, brand: string) {
  const product = await createProduct(business, {
    brand,
    name: 'Ultima',
    variants: [{ sku: 'ULT-10L', packSize: 10 }],
  });
  const variantId = product.variants[0]?.id;
  const supplier = await createSupplier(business, `${brand} Distributors`);
  for (const [invoice, quantity] of [
    ['INV-1', 10],
    ['INV-2', 25],
  ] as const) {
    await call('POST', '/goods-receipts', {
      token: business.token,
      body: {
        storeId: business.stores[0]?.id,
        supplierId: supplier,
        supplierInvoiceNumber: invoice,
        supplierInvoiceDate: indiaDay(0),
        lines: [{ variantId, quantity, unitCostPaise: invoice === 'INV-1' ? 4_000_00 : 400_00 }],
      },
    });
  }
  const brands = await call<{ id: string; name: string }[]>('GET', '/brands', {
    token: business.token,
  });
  const brandId = String(brands.find((row) => row.name === brand)?.id);
  const scheme = await call<{ id: string }>('POST', '/brand-schemes', {
    token: business.token,
    body: {
      brandId,
      name: 'Festive slab',
      startsOn: indiaDay(-20),
      endsOn: indiaDay(10),
      measure: 'value',
      slabs: [{ target: 30_000_00, benefits: [{ kind: 'rebate', basisPoints: 100 }] }],
    },
  });
  await call('POST', `/brand-schemes/${scheme.id}/activate`, { token: business.token });
  return { supplier, brandId };
}

/** The distributor's statement: INV-1 as we have it, INV-2 ₹250 more, INV-9 never received, a credit note. */
function statementCsv(): string {
  const today = dmy(indiaDay(0));
  return [
    'Date,Document No,Type,Narration,Debit,Credit',
    `${today},INV-1,Invoice,Ultima,"40,000.00",`,
    `${today},INV-2,Invoice,Ultima,"10,250.00",`,
    `${today},INV-9,Invoice,Not received,"7,000.00",`,
    `${today},CN-77,Credit Note,Festive slab rebate,,400.00`,
    ',,Total,,"57,250.00",400.00',
  ].join('\r\n');
}

const brandSide = (page: Page) => page.getByRole('table', { name: 'The brand’s statement' });
const lineRow = (page: Page, document: string) =>
  brandSide(page).getByRole('row').filter({ hasText: document });

test('a template, a month’s statement uploaded, reconciled and its mismatches settled', async ({
  page,
}) => {
  test.slow();
  const business = await createBusiness('Statement Paints');
  await bought(business, 'Apex Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();

  await page.goto('/brand-statements');
  await expect(page.getByText(/No brand statement yet/)).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: 'Statement templates' }).click();
  await page.getByRole('link', { name: 'New template' }).click();
  await expect(page.getByRole('heading', { name: 'New statement template' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Template name' }).fill('Apex ledger');
  await page
    .getByRole('combobox', { name: 'Supplier' })
    .selectOption({ label: 'Apex Paints Distributors' });
  await page
    .getByRole('combobox', { name: 'Brand of its scheme credit notes' })
    .selectOption({ label: 'Apex Paints' });
  await page.getByRole('combobox', { name: 'Compare GRNs' }).selectOption('taxable');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save template' }).click();
  await expect(page.getByText('Template saved')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Statement templates' })).toContainText(
    'Apex ledgerApex Paints DistributorsApex Paints',
  );
  await expectUsable(page);

  await page.goto('/brand-statements/upload');
  await page
    .getByRole('combobox', { name: 'Template' })
    .selectOption({ label: 'Apex ledger · Apex Paints Distributors' });
  await page.getByLabel('Statement file').setInputFiles({
    name: 'Apex statement.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(statementCsv()),
  });
  await page.getByRole('button', { name: 'Check the file' }).click();
  await expect(page.getByText(/4 lines from/)).toBeVisible();
  await expect(page.getByText('Rows left out (totals, blank amounts)')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Import and match' }).click();
  await expect(page.getByText('Statement imported and matched')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'BS-000001: Apex Paints Distributors', level: 1 }),
  ).toBeVisible();
  await expect(lineRow(page, 'INV-1')).toContainText('Matched');
  await expect(lineRow(page, 'INV-2')).toContainText('Amount differs');
  await expect(lineRow(page, 'INV-2')).toContainText('differs by ₹250.00');
  await expect(lineRow(page, 'INV-9')).toContainText('Not matched');
  await expect(lineRow(page, 'CN-77')).toContainText('Not matched');
  await expect(page.getByText(/The original file was not kept/)).toBeVisible();
  await expectUsable(page);

  // The credit note is the scheme's rebate: recorded and matched in one step.
  await lineRow(page, 'CN-77')
    .getByRole('button', { name: 'Record as scheme credit note' })
    .click();
  let dialog = page.getByRole('dialog', { name: /as a scheme credit note/ });
  await dialog.getByRole('combobox', { name: 'Scheme' }).selectOption({ label: 'Festive slab' });
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Record and match' }).click();
  await expect(lineRow(page, 'CN-77')).toContainText('Matched');
  await expect(page.getByRole('table', { name: 'Our books' })).toContainText('Festive slab');

  // A member unmatches INV-1 and matches it again by hand.
  await lineRow(page, 'INV-1').getByRole('button', { name: 'Unmatch' }).click();
  await expect(lineRow(page, 'INV-1')).toContainText('Not matched');
  await lineRow(page, 'INV-1').getByRole('button', { name: 'Match' }).click();
  dialog = page.getByRole('dialog', { name: /with a record of ours/ });
  await dialog.getByRole('combobox', { name: 'Record' }).selectOption({ index: 1 });
  await dialog
    .getByRole('textbox', { name: 'Note (optional)' })
    .fill('Checked with the distributor');
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Match' }).click();
  await expect(lineRow(page, 'INV-1')).toContainText('Note: Checked with the distributor');

  // The invoice whose goods never came is explained.
  await lineRow(page, 'INV-9').getByRole('button', { name: 'Explain' }).click();
  dialog = page.getByRole('dialog', { name: /Explain row/ });
  await dialog
    .getByRole('textbox', { name: 'Why it is not in our books' })
    .fill('Goods not delivered: asked the distributor for a credit note');
  await dialog.getByRole('button', { name: 'Mark explained' }).click();
  await expect(lineRow(page, 'INV-9')).toContainText('Explained');

  await page.getByRole('combobox', { name: 'Show' }).selectOption('problems');
  await expect(brandSide(page).getByRole('row')).toHaveCount(2);
  await expectUsable(page);
  await page.goto('/brand-statements');
  await expect(page.getByRole('table', { name: 'Brand statements' })).toContainText('BS-000001');
  await expectUsable(page);
});

test('brand statements on a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Statement Paints');
  const { supplier, brandId } = await bought(business, 'Berger');
  const template = await call<{ id: string }>('POST', '/brand-statements/templates', {
    token: business.token,
    body: {
      name: 'Berger ledger',
      supplierPartyId: supplier,
      brandId,
      dateColumn: 'Date',
      documentColumn: 'Document No',
      typeColumn: 'Type',
      descriptionColumn: 'Narration',
      amountMode: 'debit_credit',
      debitColumn: 'Debit',
      creditColumn: 'Credit',
      typeRules: { credit_note: ['Credit Note'] },
      grnAmountBasis: 'taxable',
    },
  });
  const form = new FormData();
  form.set('templateId', template.id);
  form.set('file', new Blob([statementCsv()], { type: 'text/csv' }), 'Berger.csv');
  const imported = await fetch(`${API_URL}/brand-statements`, {
    method: 'POST',
    headers: { authorization: `Bearer ${business.token}` },
    body: form,
  });
  expect(imported.status).toBe(201);
  const { statement } = (await imported.json()) as { statement: { id: string } };

  await signInWithPassword(page, business.ownerPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await page.goto('/brand-statements');
  await expect(page.getByText('BS-000001')).toBeVisible();
  await expectUsable(page);
  await page.goto(`/brand-statements/${statement.id}`);
  await expect(lineRow(page, 'INV-2')).toContainText('Amount differs');
  await expectUsable(page);
  await page.goto('/brand-statements/templates');
  await expect(page.getByText('Berger ledger')).toBeVisible();
  await expectUsable(page);
  await page.goto('/brand-statements/upload');
  await expect(page.getByRole('heading', { name: 'Upload a brand statement' })).toBeVisible();
  await expectUsable(page);
});
