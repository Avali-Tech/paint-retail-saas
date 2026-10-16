import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en.js';
import { hi } from '../src/i18n/hi.js';
import { expectUsable } from './checks.js';
import { openingStock } from './inventory-support.js';
import {
  PASSWORD,
  addMember,
  call,
  createBusiness,
  signInWithPassword,
  uniquePhone,
  type Business,
} from './support.js';

// A pilot shop's collections morning (MVP 3 round 6, spec §7), through the screens: a
// collector opens their worklist, records two promises, sends a UPI link that the
// customer pays on the log gateway's test page (whose signed webhook records and
// allocates the money by itself), and the worklist, receivables, statement and ledger
// then agree to the paisa. On desktop in English, and on a phone in Hindi. The worker's
// reminder run with its link is collections-morning.int.test.ts.

const TELANGANA_GSTIN = '36AABCS1429B1ZV';

type Messages = typeof en;

interface Morning {
  readonly business: Business;
  readonly collectorPhone: string;
  readonly parties: Readonly<Record<'krishna' | 'lakshmi' | 'ravi' | 'venkat', string>>;
}

/** `{name}`-style placeholders filled in. */
const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A registered store, a collector (sales executive) and four customers they look after,
 * billed for ₹118.00 brushes with due dates long past (always overdue) or far ahead:
 *
 * - Krishna: ₹590.00 due 2020 with ₹100.00 paid on it; overdue ₹490.00.
 * - Lakshmi: ₹236.00 due mid-2020.
 * - Ravi: ₹590.00 due 2021, and ₹118.00 due 2099; pays the overdue by link.
 * - Venkat: ₹118.00 due 2099; not on the worklist.
 */
async function morningShop(name: string): Promise<Morning> {
  const business = await createBusiness(name, [['AMP', 'Ameerpet']]);
  const { token } = business;
  const storeId = String(business.stores[0]?.id);
  await call('PUT', '/gst-registrations/business', { token, body: { legalName: `${name} LLP` } });
  await call('PUT', `/gst-registrations/stores/${storeId}`, {
    token,
    body: { registrationType: 'regular', stateCode: '36', gstin: TELANGANA_GSTIN },
  });
  const { categories } = await call<{ categories: { id: string; key: string | null }[] }>(
    'GET',
    '/tax-categories/options',
    { token },
  );
  const brand = await call<{ id: string }>('POST', '/brands', { token, body: { name: 'Asian' } });
  const product = await call<{ variants: { id: string }[] }>('POST', '/products', {
    token,
    body: {
      brandId: brand.id,
      name: 'Paint Brush',
      type: 'tool',
      hsnCode: '9603',
      taxCategoryId: categories.find((option) => option.key === 'brushes_rollers')?.id,
      variants: [
        { sku: 'BR-4', packSize: 1, unit: 'piece', label: '4 inch', sellingPricePaise: 11_800 },
      ],
    },
  });
  const brush = String(product.variants[0]?.id);
  await openingStock(business, storeId, [{ variantId: brush, quantity: 50, unitCostPaise: 6_000 }]);

  const collectorPhone = uniquePhone();
  await addMember(business, 'sales_executive', {
    fullName: 'Kiran Collector',
    phone: collectorPhone,
    password: PASSWORD,
  });
  const { token: collectorToken } = await call<{ token: string }>('POST', '/auth/login', {
    body: { identifier: collectorPhone, password: PASSWORD },
  });
  const { memberId } = await call<{ memberId: string }>('GET', '/auth/me', {
    token: collectorToken,
  });
  const customer = async (displayName: string) =>
    (
      await call<{ id: string }>('POST', '/parties', {
        token,
        body: {
          displayName,
          phone: uniquePhone(),
          roles: ['customer'],
          homeStoreId: storeId,
          customer: { assignedMemberId: memberId },
        },
      })
    ).id;
  const bill = async (partyId: string, quantity: number, dueOn: string) => {
    const draft = await call<{ id: string }>('POST', '/invoices', {
      token,
      body: { storeId, partyId, dueOn, lines: [{ variantId: brush, quantity }] },
    });
    return call<{ id: string }>('POST', `/invoices/${draft.id}/issue`, { token, body: {} });
  };
  const parties = {
    krishna: await customer('Krishna Constructions'),
    lakshmi: await customer('Lakshmi Interiors'),
    ravi: await customer('Ravi Builders'),
    venkat: await customer('Venkat Homes'),
  };
  const old = await bill(parties.krishna, 5, '2020-01-01');
  const modes = await call<{ id: string; kind: string }[]>('GET', '/payment-modes', { token });
  await call('POST', '/payments', {
    token,
    body: {
      storeId,
      partyId: parties.krishna,
      modeId: modes.find((mode) => mode.kind === 'bank_transfer')?.id,
      amountPaise: 10_000,
      allocations: [{ documentId: old.id, amountPaise: 10_000 }],
    },
  });
  await bill(parties.lakshmi, 2, '2020-06-01');
  await bill(parties.ravi, 5, '2021-01-01');
  await bill(parties.ravi, 1, '2099-01-01');
  await bill(parties.venkat, 1, '2099-01-01');
  return { business, collectorPhone, parties };
}

/** Each customer's ledger balance, ageing net and statement closing, by the API. */
async function figures(books: Morning) {
  const { token } = books.business;
  const ageing = await call<{ rows: { id: string; totals: { netPaise: number } }[] }>(
    'GET',
    '/receivables/ageing?limit=200',
    { token },
  );
  const result: Record<string, [number, number, number]> = {};
  for (const [key, partyId] of Object.entries(books.parties)) {
    const ledger = await call<{ balancePaise: number }>('GET', `/parties/${partyId}/ledger`, {
      token,
    });
    const statement = await call<{ closingPaise: number }>(
      'GET',
      `/parties/${partyId}/statement?from=2019-04-01&to=2099-12-31`,
      { token },
    );
    const net = ageing.rows.find((row) => row.id === partyId)?.totals.netPaise ?? 0;
    result[key] = [ledger.balancePaise, net, statement.closingPaise];
  }
  return result;
}

async function collectionsMorning(page: Page, books: Morning, m: Messages) {
  // 1. The collector's worklist: their three late customers, the oldest debt first.
  await page.goto('/collections');
  await expect(page.getByRole('heading', { name: m.collections.title, level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: m.collections.table });
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Krishna Constructions');
  await expect(rows.nth(0)).toContainText('₹490.00');
  await expect(rows.nth(1)).toContainText('Lakshmi Interiors');
  await expect(rows.nth(2)).toContainText('Ravi Builders');
  await expect(rows.nth(2)).toContainText('₹590.00');
  await expectUsable(page);

  // 2. Two calls, two promises.
  for (const [name, amount] of [
    ['Krishna Constructions', '490'],
    ['Lakshmi Interiors', '236'],
  ] as const) {
    await table.getByRole('button', { name: fill(m.collections.recordName, { name }) }).click();
    const dialog = page.getByRole('dialog', { name: m.collections.dialog.title });
    await dialog.getByLabel(m.collections.dialog.amount).fill(amount);
    if (name === 'Krishna Constructions') await expectUsable(page);
    await dialog.getByRole('button', { name: m.collections.dialog.save }).click();
    await expect(page.getByText(m.collections.dialog.saved)).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(table.locator('tbody tr', { hasText: name })).toContainText(`₹${amount}.00 `);
  }

  // 3. A UPI link to Ravi for what is overdue, paid on the test gateway's page.
  await table
    .getByRole('button', { name: fill(m.paymentLinks.sendName, { name: 'Ravi Builders' }) })
    .click();
  const linkDialog = page.getByRole('dialog', { name: m.paymentLinks.dialog.title });
  await linkDialog.getByRole('button', { name: m.paymentLinks.dialog.create }).click();
  const [before, after] = m.paymentLinks.result.title.split('{number}');
  const result = page.getByRole('dialog', {
    name: new RegExp(`^${escape(String(before))}PL-\\d{6}${escape(String(after))}$`),
  });
  await expect(result).toBeVisible();
  const url = (await result.locator('code').textContent()) ?? '';
  expect(url).toMatch(/\/pay\/plink_log_[\w-]{22}$/);
  await result.getByRole('button', { name: m.paymentLinks.result.done }).click();
  await page.goto(url);
  await expect(page.getByRole('heading', { name: m.logCheckout.title })).toBeVisible();
  await expect(page.getByLabel(m.logCheckout.payAmount)).toHaveValue('590.00');
  await expectUsable(page);
  await page.getByRole('button', { name: m.logCheckout.pay }).click();
  await expect(page.getByText(m.logCheckout.applied)).toBeVisible();

  // 4. The worklist after: Ravi is off it; the two promises wait.
  await page.goto('/collections');
  await expect(rows).toHaveCount(2);
  await expect(table).not.toContainText('Ravi Builders');
  for (const [name, amount] of [
    ['Krishna Constructions', '₹490.00'],
    ['Lakshmi Interiors', '₹236.00'],
  ] as const) {
    const row = table.locator('tbody tr', { hasText: name });
    await expect(row).toContainText(
      fill(m.collections.promiseSummary, { amount, date: '' }).trim(),
    );
  }
  await expectUsable(page);

  // 5. Receivables: ₹490 + ₹236 + ₹118 + ₹118 outstanding, ₹726 of it overdue.
  await page.goto('/receivables');
  const tiles = page.getByRole('region', { name: m.receivables.tiles.label });
  await expect(tiles).toContainText('₹962.00');
  await expect(tiles).toContainText('₹726.00');
  await expectUsable(page);

  // 6. Ravi's statement closes on the bill not yet due.
  await page.goto(`/parties/${books.parties.ravi}/statement`);
  await expect(
    page.getByRole('heading', {
      name: fill(m.statement.title, { name: 'Ravi Builders' }),
      level: 1,
    }),
  ).toBeVisible();
  await expect(page.getByText('118.00 Dr').first()).toBeVisible();
  await expectUsable(page);

  // 7. Every customer's ledger, ageing and statement agree to the paisa.
  expect(await figures(books)).toEqual({
    krishna: [49_000, 49_000, 49_000],
    lakshmi: [23_600, 23_600, 23_600],
    ravi: [11_800, 11_800, 11_800],
    venkat: [11_800, 11_800, 11_800],
  });
}

test('a pilot shop’s collections morning: worklist, two promises, a UPI payment allocated by itself, and the books agree', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const books = await morningShop('Morning Paints');
  await signInWithPassword(page, books.collectorPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await collectionsMorning(page, books, en);
});

test('the collections morning on a phone in Hindi @phone', async ({ page }) => {
  test.setTimeout(90_000);
  const books = await morningShop('Subah Paints');
  await signInWithPassword(page, books.collectorPhone);
  await expect(page.locator('.shell__header')).toBeVisible();
  await page.goto('/settings/security');
  await page
    .getByRole('group', { name: 'Language' })
    .getByRole('button', { name: 'हिन्दी' })
    .click();
  await expect(page.getByRole('heading', { name: hi.security.title, level: 1 })).toBeVisible();
  await collectionsMorning(page, books, hi);
});
