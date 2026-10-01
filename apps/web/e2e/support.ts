import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';
import { API_LOG, API_URL } from './env.js';

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

export async function signInWithPassword(page: Page, identifier: string, password = PASSWORD) {
  await page.goto('/sign-in');
  await page.getByRole('textbox', { name: 'Mobile number or email' }).fill(identifier);
  await page.getByLabel('Password', { exact: true }).and(page.locator('input')).fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The session token the app stored after signing in. */
export async function storedToken(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('paint.session');
    return raw === null ? '' : (JSON.parse(raw) as { token: string }).token;
  });
}
