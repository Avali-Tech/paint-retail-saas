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

  test(`phone screens fit in ${language.code} @phone`, async ({ page }) => {
    await signedInBusiness(page, `Phone Bhasha ${language.code} Paints`);
    await chooseLanguage(page, language);
    await expectUsable(page);
    const { messages } = language;

    const screens: [path: string, heading: string][] = [
      ['/', messages.dashboard.title],
      ['/parties', messages.parties.title],
      ['/parties/new', messages.parties.form.newTitle],
      ['/products', messages.products.title],
      ['/stock', messages.stock.title],
      ['/transfers/new', messages.transfers.form.title],
      ['/purchase-orders', messages.purchasing.orderList.title],
      ['/leads', messages.leads.title],
      ['/follow-ups', messages.followUps.title],
      ['/contracts', messages.contracts.title],
      ['/reports', messages.reports.title],
      ['/team', messages.team.title],
      ['/settings/appearance', messages.appearance.title],
      ['/documents', messages.documents.page.title],
      ['/activities', messages.activities.title],
      ['/products/setup', messages.catalogSetup.title],
      ['/settings/support', messages.supportAccess.title],
    ];
    for (const [path, heading] of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
      await expectUsable(page);
    }

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
