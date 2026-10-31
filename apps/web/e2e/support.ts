import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { API_LOG, API_URL } from './env.js';
import { nextCode } from './totp.js';

// Test data goes in through the real API, the same way the app's users create it.
// Every test makes its own business, so tests run in parallel without sharing data.

let counter = 0;
/** A mobile number no other test uses: +91 9 + 9 digits. */
export function uniquePhone(): string {
  counter += 1;
  const tail = `${String(Date.now() % 10_000_000).padStart(7, '0')}${String((process.pid + counter) % 100).padStart(2, '0')}`;
  return `+919${tail}`;
}

export const PASSWORD = 'Staff@2026';

export async function call<T>(
  method: string,
  path: string,
  { token, body }: { token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${String(response.status)} ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export interface Business {
  readonly name: string;
  readonly ownerPhone: string;
  readonly token: string;
  readonly stores: { readonly id: string; readonly code: string; readonly name: string }[];
}

/** Signs a new business up and adds stores, like an owner would on day one. */
export async function createBusiness(
  name: string,
  stores: readonly [code: string, name: string][] = [
    ['HYD', 'Hyderabad'],
    ['PUN', 'Pune'],
  ],
): Promise<Business> {
  const ownerPhone = uniquePhone();
  const { token } = await call<{ token: string }>('POST', '/auth/signup', {
    body: { organizationName: name, fullName: 'Anil Owner', phone: ownerPhone, password: PASSWORD },
  });
  const created = [];
  for (const [code, storeName] of stores) {
    created.push(
      await call<{ id: string; code: string; name: string }>('POST', '/stores', {
        token,
        body: { name: storeName, code },
      }),
    );
  }
  return { name, ownerPhone, token, stores: created };
}

/** Adds a team member with a standard role; without a password they sign in by SMS code. */
export async function addMember(
  business: Business,
  roleKey: string,
  person: { fullName: string; phone: string; password?: string },
): Promise<void> {
  const roles = await call<{ id: string; key: string }[]>('GET', '/roles', {
    token: business.token,
  });
  await call('POST', '/members', {
    token: business.token,
    body: {
      ...person,
      roleId: roles.find((role) => role.key === roleKey)?.id,
      storeIds: business.stores.slice(0, 1).map((store) => store.id),
    },
  });
}

/** The latest one-time code texted to `phone` (the API logs texts in tests). */
export async function lastCodeFor(phone: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(() => {
      const log = readFileSync(API_LOG, 'utf8');
      const sent = [...log.matchAll(/To (\+\d+): (\d{6}) is your sign-in code/g)].filter(
        (match) => match[1] === phone,
      );
      code = sent.at(-1)?.[2];
      return code;
    })
    .toBeDefined();
  return String(code);
}

/** The first step only: fills in and sends the password form. */
export async function submitPassword(page: Page, identifier: string, password = PASSWORD) {
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Mobile number or email' }).fill(identifier);
  await page.getByLabel('Password', { exact: true }).and(page.locator('input')).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** A person's authenticator app as the tests keep it: its secret, the last step used, recovery codes. */
export interface Authenticator {
  readonly secret: string;
  lastStep: number | null;
  readonly recoveryCodes: string[];
}

/** Authenticator apps the tests added, by sign-in identifier (each test has its own people). */
export const authenticators = new Map<string, Authenticator>();

/** The setup key the sign-in screen shows, without the spaces that group it. */
export async function shownSecret(page: Page): Promise<string> {
  return (await page.getByRole('textbox', { name: 'Setup key' }).inputValue()).replaceAll(' ', '');
}

/** Reads the recovery codes on screen, then ticks "saved" and continues. */
export async function keepRecoveryCodes(page: Page): Promise<string[]> {
  const list = page.getByRole('list', { name: 'Recovery codes' });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  const codes = await list.getByRole('listitem').allTextContents();
  await page.getByRole('checkbox', { name: 'I have saved my recovery codes' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  return codes;
}

/** Adds an authenticator app through the API, as if done earlier on Account security. */
export async function addAuthenticator(identifier: string, token: string): Promise<Authenticator> {
  const { secret } = await call<{ secret: string }>('POST', '/auth/2fa/enrol', { token });
  const { code, step } = await nextCode(secret, null);
  const { recoveryCodes } = await call<{ recoveryCodes: string[] }>('POST', '/auth/2fa/confirm', {
    token,
    body: { code },
  });
  const app = { secret, lastStep: step, recoveryCodes };
  authenticators.set(identifier, app);
  return app;
}

/** Enters the app's next code (codes never repeat) on the two-factor step. */
export async function enterAppCode(page: Page, identifier: string) {
  const app = authenticators.get(identifier);
  if (!app) throw new Error(`No authenticator app kept for ${identifier}`);
  const { code, step } = await nextCode(app.secret, app.lastStep);
  app.lastStep = step;
  await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
}

/**
 * After the first step: completes two-factor sign-in the way the person would,
 * when it is asked for. The first time, the app is added with the setup key and
 * its recovery codes are kept; later, the app's next code is entered.
 */
export async function finishTwoFactor(page: Page, identifier: string) {
  const setup = page.getByRole('heading', { name: 'Add an authenticator app' });
  const prompt = page.getByRole('heading', { name: 'Confirm it’s you' });
  const signedIn = page.locator('.shell__header');
  await expect(setup.or(prompt).or(signedIn)).toBeVisible();
  if (await signedIn.isVisible()) return;

  if (await setup.isVisible()) {
    const secret = await shownSecret(page);
    const { code, step } = await nextCode(secret, null);
    await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
    await page.getByRole('button', { name: 'Verify and sign in' }).click();
    authenticators.set(identifier, {
      secret,
      lastStep: step,
      recoveryCodes: await keepRecoveryCodes(page),
    });
    return;
  }
  await enterAppCode(page, identifier);
}

/** Signs in with a password, through two-factor sign-in when the person's role needs it. */
export async function signInWithPassword(page: Page, identifier: string, password = PASSWORD) {
  await submitPassword(page, identifier, password);
  await finishTwoFactor(page, identifier);
}

/**
 * Opens a page the way a person does on a wide screen: a section in the side
 * menu, then one of its tabs. Settings pages are listed on the Settings page.
 */
export async function openFromMenu(page: Page, section: string, tab?: string) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: section, exact: true })
    .click();
  if (tab === undefined) return;
  const links =
    section === 'Settings'
      ? page.getByRole('main')
      : page.getByRole('navigation', { name: section, exact: true });
  await links.getByRole('link', { name: tab, exact: true }).click();
}

/** The session token the app stored after signing in. */
export async function storedToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('paint.session');
    return raw === null ? '' : (JSON.parse(raw) as { token: string }).token;
  });
}

/** WCAG 2 A and AA problems on the page, as "rule: target" lines. */
export async function accessibilityProblems(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  return results.violations.flatMap((violation) =>
    violation.nodes.map((node) => `${violation.id}: ${node.target.join(' ')}`),
  );
}
