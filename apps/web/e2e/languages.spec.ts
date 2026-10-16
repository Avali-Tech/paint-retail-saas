import { devices, expect, test, type Page } from '@playwright/test';
import { hi } from '../src/i18n/hi.js';
import { te } from '../src/i18n/te.js';
import { expectUsable } from './checks.js';
import { createProduct } from './inventory-support.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

/** The operator session the global setup created (see platform.spec.ts). */
function operatorToken(): string {
  return (JSON.parse(String(process.env.E2E_PLATFORM_SESSION)) as { token: string }).token;
}

// Hindi and Telugu: the switch on the sign-in page and under Account security, and
// the screens in each language, checked with axe and for sideways scrolling on a phone
// (Devanagari and Telugu text is often longer than English).

const LANGUAGES = [
  { code: 'hi', name: 'हिन्दी', lang: 'hi-IN', messages: hi },
  { code: 'te', name: 'తెలుగు', lang: 'te-IN', messages: te },
] as const;

/** A business with a product and a customer, signed in as its owner (in English). */
async function signedInBusiness(page: Page, name: string): Promise<Business> {
  const business = await createBusiness(name);
  await createProduct(business, { brand: 'Asian Paints' });
  await call('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Ramesh Kumar Contractors', roles: ['customer', 'contractor'] },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return business;
}

/** Account security → Language → the language's own name. */
async function chooseLanguage(page: Page, language: (typeof LANGUAGES)[number]) {
  await page.goto('/settings/security');
  await page
    .getByRole('group', { name: 'Language' })
    .getByRole('button', { name: language.name })
    .click();
  await expect(
    page.getByRole('heading', { name: language.messages.security.title, level: 1 }),
  ).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', language.lang);
}

/** An India date `days` from today, as YYYY-MM-DD. */
const indiaDay = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });

/**
 * Brand money for the round 5 screens (P2-M33, P2-M35): a registered store selling a
 * brand's 10 L pack, a GRN of the brand today, a running scheme with a filed claim,
 * and a bill today (this quarter's profitability). Signed in as the owner.
 */
async function brandMoneyBusiness(page: Page, name: string): Promise<string> {
  const business = await createBusiness(name, [['AMP', 'Ameerpet']]);
  const { token } = business;
  const storeId = String(business.stores[0]?.id);
  await call('PUT', '/gst-registrations/business', { token, body: { legalName: `${name} LLP` } });
  await call('PUT', `/gst-registrations/stores/${storeId}`, {
    token,
    body: { registrationType: 'regular', stateCode: '36', gstin: '36AABCS1429B1ZV' },
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
  const product = await call<{ variants: { id: string }[] }>('POST', '/products', {
    token,
    body: {
      brandId: brand.id,
      name: 'Apex Ultima',
      type: 'exterior_paint',
      hsnCode: '3209',
      taxCategoryId: categories.find((option) => option.key === 'paints')?.id,
      variants: [{ sku: 'APX-10L', packSize: 10, unit: 'l', sellingPricePaise: 5_900_00 }],
    },
  });
  const variantId = String(product.variants[0]?.id);
  const supplier = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { kind: 'organization', displayName: 'Deccan Distributors', roles: ['supplier'] },
  });
  await call('POST', '/goods-receipts', {
    token,
    body: {
      storeId,
      supplierId: supplier.id,
      supplierInvoiceNumber: 'INV-1',
      lines: [{ variantId, quantity: 10, freeQuantity: 1, unitCostPaise: 4_000_00 }],
    },
  });
  const scheme = await call<{ id: string }>('POST', '/brand-schemes', {
    token,
    body: {
      brandId: brand.id,
      name: 'Festive slab',
      startsOn: indiaDay(-10),
      endsOn: indiaDay(19),
      measure: 'value',
      slabs: [
        { target: 30_000_00, benefits: [{ kind: 'rebate', basisPoints: 100 }] },
        { target: 60_000_00, benefits: [{ kind: 'points', label: 'Goa trip', points: 1 }] },
      ],
    },
  });
  await call('POST', `/brand-schemes/${scheme.id}/activate`, { token });
  await call('POST', `/brand-schemes/${scheme.id}/claims`, {
    token,
    body: { filedOn: indiaDay(0) },
  });
  const party = await call<{ id: string }>('POST', '/parties', {
    token,
    body: { displayName: 'Suresh Reddy', roles: ['customer'] },
  });
  const draft = await call<{ id: string }>('POST', '/invoices', {
    token,
    body: { storeId, partyId: party.id, lines: [{ variantId, quantity: 2 }] },
  });
  await call('POST', `/invoices/${draft.id}/issue`, { token, body: {} });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return scheme.id;
}

/** Brand schemes, a scheme with its dialogs, claims, the planner and brand profitability. */
async function brandMoneyScreens(page: Page, schemeId: string, messages: typeof hi) {
  const { schemes, priceHike, brandProfitability } = messages;
  await page.goto('/brand-schemes');
  await expect(page.getByRole('heading', { name: schemes.title, level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Asian Paints · Festive slab' })).toBeVisible();
  await expectUsable(page);
  await page.goto(`/brand-schemes/${schemeId}`);
  await expect(
    page.getByRole('heading', { name: 'Asian Paints · Festive slab', level: 1 }),
  ).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: schemes.receipt.title }).click();
  await expect(page.getByRole('dialog', { name: schemes.receipt.title })).toBeVisible();
  await expectUsable(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: schemes.receipt.title })).toBeHidden();
  await page.goto(`/brand-schemes/${schemeId}/edit`);
  await expect(
    page.getByRole('heading', { name: schemes.editor.editTitle, level: 1 }),
  ).toBeVisible();
  await expectUsable(page);
  await page.goto('/brand-schemes/claims');
  await expect(page.getByRole('heading', { name: schemes.claims.title, level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: schemes.claims.schemes })).toContainText(
    'Festive slab',
  );
  await expectUsable(page);
  await page.goto('/brand-schemes/price-hike');
  await expect(page.getByRole('heading', { name: priceHike.title, level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: schemes.brand }).selectOption({ label: 'Asian Paints' });
  await page.getByRole('textbox', { name: priceHike.hike }).fill('5');
  await page.getByRole('button', { name: priceHike.plan }).click();
  await expect(page.getByRole('table', { name: priceHike.table })).toContainText('APX-10L');
  await expectUsable(page);
  await page.goto('/reports/brand-profitability?period=thisQuarter&groupBy=product');
  await expect(
    page.getByRole('heading', { name: brandProfitability.title, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: brandProfitability.headline.label })).toContainText(
    'Asian Paints',
  );
  await expectUsable(page);
  await page.getByRole('button', { name: brandProfitability.settings.open }).click();
  await expect(page.getByRole('dialog', { name: brandProfitability.settings.title })).toBeVisible();
  await expectUsable(page);
}

test('the sign-in page switches language and remembers it', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-IN');
  for (const language of LANGUAGES) {
    await page.getByRole('button', { name: language.name }).click();
    await expect(
      page.getByRole('button', { name: language.messages.auth.signIn, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('tab', { name: language.messages.auth.otp })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', language.lang);
    await expectUsable(page);
  }
  await page.reload();
  await expect(page.getByRole('button', { name: te.auth.signIn, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

for (const language of LANGUAGES) {
  test(`the app in ${language.code}: translated screens, kept after a reload`, async ({ page }) => {
    await signedInBusiness(page, `Bhasha ${language.code} Paints`);
    await chooseLanguage(page, language);
    const { messages } = language;

    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: messages.dashboard.title, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('navigation', { name: messages.shell.mainNav })).toContainText(
      messages.nav.customers,
    );
    await page.reload();
    await expect(
      page.getByRole('heading', { name: messages.dashboard.title, level: 1 }),
    ).toBeVisible();
    await expectUsable(page);

    await page.goto('/parties');
    await expect(
      page.getByRole('heading', { name: messages.parties.title, level: 1 }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Ramesh Kumar Contractors' })).toBeVisible();
    await expectUsable(page);

    await page.goto('/products');
    await expect(
      page.getByRole('heading', { name: messages.products.title, level: 1 }),
    ).toBeVisible();
    await expectUsable(page);

    // Quick actions come from the API in English; the app names them in the language.
    await page.getByRole('combobox', { name: messages.search.label }).click();
    await expect(
      page
        .getByRole('group', { name: messages.search.actions })
        .getByRole('option', { name: messages.enums.quickActions.new_contract }),
    ).toBeVisible();
  });

  // One test per group of screens: each screen runs axe twice (plain and wider text),
  // which on a 2-core CI runner doesn't fit in one test's time for every screen.
  const phoneScreens = (messages: typeof hi): [path: string, heading: string][][] => [
    [
      ['/', messages.dashboard.title],
      ['/parties', messages.parties.title],
      ['/parties/new', messages.parties.form.newTitle],
      ['/products', messages.products.title],
    ],
    [
      ['/stock', messages.stock.title],
      ['/transfers/new', messages.transfers.form.title],
      ['/purchase-orders', messages.purchasing.orderList.title],
      ['/leads', messages.leads.title],
    ],
    [
      ['/follow-ups', messages.followUps.title],
      ['/contracts', messages.contracts.title],
      ['/reports', messages.reports.title],
      ['/team', messages.team.title],
    ],
    [
      ['/settings/appearance', messages.appearance.title],
      ['/documents', messages.documents.page.title],
      ['/activities', messages.activities.title],
      ['/products/setup', messages.catalogSetup.title],
      ['/settings/support', messages.supportAccess.title],
    ],
    // MVP 2: the counter, sales documents, orders and the books.
    [
      ['/pos', messages.pos.title],
      ['/invoices', messages.sales.invoices.title],
      ['/notes', messages.sales.notes.title],
      ['/quotations', messages.orders.quotations.title],
      ['/sales-orders', messages.orders.orders.title],
    ],
    [
      ['/estimates', messages.estimator.list.title],
      ['/registers', messages.books.registers.title],
      ['/payments', messages.books.payments.title],
      ['/accounting/export', messages.books.accounting.title],
    ],
    // MVP 3: credit, receivables, collections, painter points and billing.
    [
      ['/receivables', messages.receivables.title],
      ['/collections', messages.collections.title],
      ['/collections/reminders', messages.collections.schedule.title],
      ['/credit/approvals', messages.approvals.title],
    ],
    [
      ['/credit-requests', messages.credit.requests.title],
      ['/settings/credit', messages.creditRules.title],
      ['/settings/painter-points', messages.earnRules.title],
      ['/settings/billing', messages.subscription.title],
    ],
  ];

  for (const [group, screens] of phoneScreens(language.messages).entries()) {
    test(`phone screens fit in ${language.code}, part ${String(group + 1)} @phone`, async ({
      page,
    }) => {
      await signedInBusiness(page, `Phone Bhasha ${language.code} ${String(group + 1)} Paints`);
      await chooseLanguage(page, language);
      for (const [path, heading] of screens) {
        await page.goto(path);
        await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
        await expectUsable(page);
      }
    });
  }

  test(`a customer's credit, collections and statement fit in ${language.code} @phone`, async ({
    page,
  }) => {
    const { messages } = language;
    const business = await signedInBusiness(page, `Khata ${language.code} Paints`);
    const party = await call<{ id: string }>('POST', '/parties', {
      token: business.token,
      body: {
        displayName: 'Venkata Lakshmi Constructions',
        roles: ['customer', 'contractor'],
        phone: '+919876543210',
      },
    });
    await chooseLanguage(page, language);
    await page.goto(`/parties/${party.id}`);
    await expect(
      page.getByRole('heading', { name: 'Venkata Lakshmi Constructions', level: 1 }),
    ).toBeVisible();
    await expectUsable(page);
    // Consent to messages: the notice is read out in the customer's language.
    await page
      .getByRole('region', { name: messages.messaging.title })
      .getByRole('button', { name: messages.messaging.record })
      .click();
    await expect(page.getByRole('dialog', { name: messages.messaging.dialog.title })).toBeVisible();
    await expectUsable(page);
    await page.keyboard.press('Escape');
    await page.goto(`/parties/${party.id}/statement`);
    await expect(
      page.getByRole('heading', {
        name: messages.statement.title.replace('{name}', 'Venkata Lakshmi Constructions'),
        level: 1,
      }),
    ).toBeVisible();
    await expectUsable(page);
  });

  // Round 5's brand screens: on a desktop and on a phone, in the language.
  for (const phone of [false, true]) {
    test(`brand schemes, the planner and brand profitability in ${language.code}${phone ? ' @phone' : ', on a desktop'}`, async ({
      page,
    }) => {
      test.setTimeout(90_000);
      const schemeId = await brandMoneyBusiness(
        page,
        `Brand ${language.code} ${phone ? 'Phone' : 'Desk'} Paints`,
      );
      await chooseLanguage(page, language);
      await brandMoneyScreens(page, schemeId, language.messages);
    });
  }

  test(`the phone menu fits in ${language.code} @phone`, async ({ page }) => {
    await signedInBusiness(page, `Phone Menu ${language.code} Paints`);
    await chooseLanguage(page, language);
    const { messages } = language;
    await page.getByRole('button', { name: messages.shell.more }).click();
    const more = page.getByRole('dialog', { name: messages.shell.more });
    await expect(more.getByRole('button', { name: messages.shell.signOut })).toBeVisible();
    await expectUsable(page);
  });

  test(`the console, support access and merging in ${language.code} @phone`, async ({
    page,
    browser,
  }) => {
    const { messages } = language;
    const business = await createBusiness(`Sahayata ${language.code} ${String(Date.now() % 1e6)}`);
    const tenants = await call<{ items: { id: string; name: string }[] }>(
      'GET',
      `/platform/tenants?q=${encodeURIComponent(business.name)}`,
      { token: operatorToken() },
    );
    const tenantId = String(tenants.items.find((item) => item.name === business.name)?.id);
    await call('POST', `/platform/tenants/${tenantId}/support-requests`, {
      token: operatorToken(),
      body: { reason: 'Checking the layout', minutes: 60 },
    });

    // The operator picks the language on the console's own sign-in page.
    await page.goto('/platform/sign-in');
    await page.getByRole('button', { name: language.name }).click();
    await expect(
      page.getByRole('heading', { name: messages.platform.signIn.title, level: 1 }),
    ).toBeVisible();
    await expectUsable(page);
    await page.evaluate((session) => {
      localStorage.setItem('paint.platform-session', session);
    }, String(process.env.E2E_PLATFORM_SESSION));
    const consoleScreens: [path: string, heading: string][] = [
      ['/platform/tenants', messages.platform.tenants.title],
      [`/platform/tenants/${tenantId}`, business.name],
      ['/platform/support', messages.platform.support.title],
      ['/platform/access-log', messages.platform.log.title],
    ];
    for (const [path, heading] of consoleScreens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expectUsable(page);
    }

    // The business's owner, on a phone in the same language: the request and merging.
    const ownerContext = await browser.newContext({ ...devices['Pixel 5'] });
    const owner = await ownerContext.newPage();
    const party = await call<{ id: string }>('POST', '/parties', {
      token: business.token,
      body: { displayName: 'Suresh Paint House', roles: ['customer'] },
    });
    await signInWithPassword(owner, business.ownerPhone);
    await chooseLanguage(owner, language);
    await expect(owner.getByText(messages.supportAccess.banner.pending)).toBeVisible();
    await owner.goto('/settings/support');
    await expect(owner.getByRole('button', { name: messages.supportAccess.approve })).toBeVisible();
    await expectUsable(owner);
    await owner.goto(`/parties/${party.id}`);
    await owner.getByRole('button', { name: messages.parties.merge.button }).click();
    await expect(
      owner.getByRole('dialog', {
        name: messages.parties.merge.title.replace('{name}', 'Suresh Paint House'),
      }),
    ).toBeVisible();
    await expectUsable(owner);
    await ownerContext.close();
  });
}
