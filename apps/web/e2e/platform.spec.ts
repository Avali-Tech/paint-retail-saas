import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { API_URL, PLATFORM_AUTHENTICATOR_FILE, PLATFORM_OPERATOR } from './env.js';
import {
  PASSWORD,
  call,
  createBusiness,
  keepRecoveryCodes,
  shownSecret,
  signInWithPassword,
  storedToken,
  type Business,
} from './support.js';
import { nextCode } from './totp.js';

// The platform console (/platform): operators sign in on their own, with their own
// session, and look after businesses: plans, features, suspension and support access.
// There is one operator (bootstrap works once); the global setup creates it and passes
// its session on, so only the sign-in test needs authenticator codes.

interface OperatorSession {
  readonly token: string;
  readonly expiresAt: string;
}

function operatorSession(): OperatorSession {
  return JSON.parse(String(process.env.E2E_PLATFORM_SESSION)) as OperatorSession;
}

/** Starts the console signed in as the operator, as an earlier sign-in on this device would. */
async function openConsole(page: Page, path: string) {
  await page.goto('/platform/sign-in');
  await page.evaluate((session) => {
    localStorage.setItem('paint.platform-session', JSON.stringify(session));
  }, operatorSession());
  await page.goto(path);
}

/** The business's id, found the way an operator would: by name. */
async function tenantId(business: Business): Promise<string> {
  const page = await call<{ items: { id: string; name: string }[] }>(
    'GET',
    `/platform/tenants?q=${encodeURIComponent(business.name)}`,
    { token: operatorSession().token },
  );
  return String(page.items.find((item) => item.name === business.name)?.id);
}

/** The status a password sign-in answers for a business's owner. */
async function ownerSignInStatus(business: Business): Promise<number> {
  const response = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: business.ownerPhone, password: PASSWORD }),
  });
  return response.status;
}

const unique = () => String(Date.now() % 1_000_000);

test('an operator signs in with an authenticator app, apart from any business session', async ({
  page,
}) => {
  await page.goto('/platform/tenants');
  await expect(
    page.getByRole('heading', { name: 'Sign in to the platform console' }),
  ).toBeVisible();
  await expectUsable(page);
  await page.getByRole('textbox', { name: 'Email or mobile number' }).fill(PLATFORM_OPERATOR.email);
  await page.getByLabel('Password', { exact: true }).fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong email, mobile number or password');
  await page.getByLabel('Password', { exact: true }).fill(PLATFORM_OPERATOR.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const setup = page.getByRole('heading', { name: 'Add an authenticator app' });
  const prompt = page.getByRole('heading', { name: 'Confirm it’s you' });
  await expect(setup.or(prompt)).toBeVisible();
  if (await setup.isVisible()) {
    // The first sign-in: scan the QR code (here: read the setup key), confirm with a code.
    await expect(
      page.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeVisible();
    await expectUsable(page);
    const secret = await shownSecret(page);
    const { code, step } = await nextCode(secret, null);
    await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    await keepRecoveryCodes(page);
    writeFileSync(PLATFORM_AUTHENTICATOR_FILE, JSON.stringify({ secret, lastStep: step }));
  } else {
    // A retry: the app was added by the first attempt.
    expect(existsSync(PLATFORM_AUTHENTICATOR_FILE)).toBe(true);
    const app = JSON.parse(readFileSync(PLATFORM_AUTHENTICATOR_FILE, 'utf8')) as {
      secret: string;
      lastStep: number;
    };
    const { code, step } = await nextCode(app.secret, app.lastStep);
    await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    writeFileSync(PLATFORM_AUTHENTICATOR_FILE, JSON.stringify({ ...app, lastStep: step }));
  }

  await expect(page.getByRole('heading', { name: 'Businesses', level: 1 })).toBeVisible();
  expect(page.url()).toMatch(/\/platform\/tenants$/);
  await expect(page.getByText('Platform console', { exact: true })).toBeVisible();
  // The operator's token is kept on its own and works only on the platform's routes.
  expect(await storedToken(page)).toBe('');
  const token = await page.evaluate(
    () =>
      (JSON.parse(String(localStorage.getItem('paint.platform-session'))) as { token: string })
        .token,
  );
  expect(
    (await fetch(`${API_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status,
  ).toBe(401);
  await expectUsable(page);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('You have signed out of the platform console.')).toBeVisible();
  expect(
    (await fetch(`${API_URL}/platform/tenants`, { headers: { authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(401);
});

test('an operator suspends a business, which signs it out, then reactivates it', async ({
  page,
}) => {
  const business = await createBusiness(`Suspend Paints ${unique()}`);
  await openConsole(page, '/platform/tenants');
  await page.getByRole('searchbox', { name: 'Search' }).fill(business.name);
  await page.getByRole('link', { name: business.name }).click();
  await expect(page.getByRole('heading', { name: business.name, level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Usage' })).toContainText(
    'Active stores2 (no limit)',
  );
  await expectUsable(page);

  await page.getByRole('button', { name: 'Suspend business' }).click();
  const dialog = page.getByRole('dialog', { name: `Suspend ${business.name}?` });
  await dialog.getByRole('textbox', { name: /Reason/ }).fill('Payment overdue');
  await dialog.getByRole('button', { name: 'Suspend business' }).click();
  await expect(dialog.getByText('Tick the box to confirm')).toBeVisible();
  await dialog
    .getByRole('checkbox', { name: `I understand everyone at ${business.name} is signed out now` })
    .check();
  await expectUsable(page);
  await dialog.getByRole('button', { name: 'Suspend business' }).click();
  await expect(page.getByText(/Suspended on .*: Payment overdue/)).toBeVisible();

  // Everyone at the business is signed out, and cannot sign in again.
  expect(
    (await fetch(`${API_URL}/auth/me`, { headers: { authorization: `Bearer ${business.token}` } }))
      .status,
  ).toBe(401);
  expect(await ownerSignInStatus(business)).toBe(403);

  await page.getByRole('button', { name: 'Reactivate business' }).click();
  await page
    .getByRole('dialog', { name: `Reactivate ${business.name}?` })
    .getByRole('button', { name: 'Reactivate business' })
    .click();
  await expect(page.getByText(`${business.name} is active again`)).toBeVisible();
  await expect(page.getByText(/Suspended on/)).toHaveCount(0);
  expect(await ownerSignInStatus(business)).toBe(200);

  await page.getByRole('link', { name: 'All businesses' }).click();
  await page.getByRole('combobox', { name: 'Status' }).selectOption('active');
  await page.getByRole('searchbox', { name: 'Search' }).fill(business.name);
  await expect(page.getByRole('row', { name: new RegExp(business.name) })).toContainText('Active');
});

test('support access: the operator asks, the owner approves, support looks read-only and the owner sees it', async ({
  page,
  browser,
}) => {
  const business = await createBusiness(`Support Paints ${unique()}`);
  const id = await tenantId(business);

  // The operator asks for an hour of access.
  await openConsole(page, `/platform/tenants/${id}`);
  const card = page.getByRole('region', { name: 'Support access' });
  await card.getByRole('button', { name: 'Ask for access' }).click();
  const dialog = page.getByRole('dialog', { name: `Ask ${business.name} for support access` });
  await dialog
    .getByRole('textbox', { name: /Why you need access/ })
    .fill('Stock report looks wrong');
  await dialog.getByRole('combobox', { name: 'For how long, once approved' }).selectOption('60');
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(card.getByText('Waiting for the business')).toBeVisible();

  // The owner is told, and approves under Settings → Support access.
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signInWithPassword(owner, business.ownerPhone);
  await expect(owner.getByText('Platform support asks to see your business')).toBeVisible();
  await owner.getByRole('link', { name: 'Review' }).click();
  await expect(owner.getByRole('heading', { name: 'Support access', level: 1 })).toBeVisible();
  const waiting = owner.getByRole('region', { name: 'Waiting for your decision' });
  await expect(waiting).toContainText('Asha Operator asks for 1 hour(s) of read-only access');
  await expect(waiting).toContainText('Stock report looks wrong');
  await expectUsable(owner);
  await waiting.getByRole('button', { name: 'Approve' }).click();
  await expect(owner.getByText(/Approved\. Support can look in until/)).toBeVisible();
  await expect(owner.getByText('Platform support can see your business')).toBeVisible();

  // The operator opens the business's app read-only, in a new tab with its own session.
  await page.goto('/platform/support');
  const row = page.getByRole('row', { name: new RegExp(business.name) });
  await expect(row).toContainText('Active');
  const popup = page.waitForEvent('popup');
  await row.getByRole('button', { name: 'Open read-only view' }).click();
  const view = await popup;
  await view.waitForURL(/\/dashboard$/);
  await expect(view.getByText('Support view – read only')).toBeVisible();
  await expect(
    view.getByText(new RegExp(`You are looking at ${business.name} as platform support`)),
  ).toBeVisible();
  // The session lives in that tab only: nothing in localStorage, no token left in the address.
  expect(await storedToken(view)).toBe('');
  expect(view.url()).not.toContain('#support');
  await view
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Customers' })
    .click();
  await expect(view.getByRole('heading', { name: 'Customers', level: 1 })).toBeVisible();
  await expectUsable(view);
  // The console tab is still the console.
  expect(await storedToken(page)).toBe('');

  // The owner sees what support looked at.
  await owner.goto('/settings/support');
  await owner
    .getByRole('region', { name: 'Access now' })
    .getByRole('link', { name: 'Activity' })
    .click();
  const log = owner.getByRole('table', { name: 'Requests made with this access' });
  await expect(log).toContainText('/auth/me');
  await expect(log).toContainText(/\/parties/);
  await expectUsable(owner);

  // The owner ends it; support's view is signed out.
  await owner.goto('/settings/support');
  await owner.getByRole('button', { name: 'End access now' }).click();
  await expect(owner.getByText('Support access ended')).toBeVisible();
  await view.reload();
  await expect(view.getByRole('heading', { name: /Sign in to/ })).toBeVisible();

  await page.goto('/platform/access-log');
  await expect(page.getByRole('row', { name: new RegExp(business.name) })).toContainText('Ended');
  await ownerContext.close();
});

test('the console and support access are usable on a phone @phone', async ({ page, browser }) => {
  const business = await createBusiness(`Phone Support Paints ${unique()}`);
  const id = await tenantId(business);
  await call('POST', `/platform/tenants/${id}/support-requests`, {
    token: operatorSession().token,
    body: { reason: 'Checking the phone layout', minutes: 30 },
  });

  await openConsole(page, '/platform/tenants');
  await page.getByRole('searchbox', { name: 'Search' }).fill(business.name);
  await expect(page.getByRole('link', { name: business.name })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: business.name }).click();
  await expect(page.getByRole('heading', { name: business.name, level: 1 })).toBeVisible();
  await expect(page.getByText('Waiting for the business')).toBeVisible();
  await expectUsable(page);
  await page.goto('/platform/support');
  await expect(page.getByRole('row', { name: new RegExp(business.name) })).toBeVisible();
  await expectUsable(page);
  await page.goto('/platform/access-log');
  await expect(page.getByRole('row', { name: new RegExp(business.name) })).toBeVisible();
  await expectUsable(page);

  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  await signInWithPassword(owner, business.ownerPhone);
  await expect(owner.getByText('Platform support asks to see your business')).toBeVisible();
  await expectUsable(owner);
  await owner.goto('/settings/support');
  await expect(owner.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expectUsable(owner);
  await ownerContext.close();
});

test('a support link carrying an ordinary session is refused, without showing that account', async ({
  browser,
}) => {
  const business = await createBusiness(`Forged Link Paints ${unique()}`);
  const me = await call<{ organization: { id: string } }>('GET', '/auth/me', {
    token: business.token,
  });
  const forged = {
    token: business.token,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    organizationId: me.organization.id,
  };
  // A fresh browser, as the person who was sent the link would have.
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/#support=${encodeURIComponent(JSON.stringify(forged))}`);
  await expect(
    page.getByText(
      'This link isn’t a valid support view, so it was not opened. Sign in with your own account.',
    ),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.locator('.shell__header')).toHaveCount(0);
  await expect(page.getByText(business.name)).toHaveCount(0);
  expect(
    await page.evaluate(() => [
      sessionStorage.getItem('paint.session'),
      sessionStorage.getItem('paint.support-tab'),
      localStorage.getItem('paint.session'),
    ]),
  ).toEqual([null, null, null]);
  await expectUsable(page);
  await context.close();
});
