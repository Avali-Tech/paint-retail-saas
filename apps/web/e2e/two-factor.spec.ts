import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import {
  PASSWORD,
  accessibilityProblems,
  addAuthenticator,
  addMember,
  authenticators,
  call,
  createBusiness,
  enterAppCode,
  keepRecoveryCodes,
  lastCodeFor,
  shownSecret,
  signInWithPassword,
  submitPassword,
  uniquePhone,
} from './support.js';
import { nextCode } from './totp.js';

// Owners and organization admins must use two-factor sign-in by default
// (PUT /organization/security); sign-up itself signs the owner in without it.

const dashboard = (page: Page) => page.getByRole('heading', { name: 'Dashboard', level: 1 });

const signOut = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Sign out' }).click();

test('an owner adds an authenticator app from a QR code at first sign-in', async ({ page }) => {
  const business = await createBusiness('Setup Paints');
  await submitPassword(page, business.ownerPhone);

  await expect(page.getByRole('heading', { name: 'Add an authenticator app' })).toBeVisible();
  const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
  await expect(qr).toBeVisible();
  // The QR code and the "open the app" link carry the same otpauth:// URI as the setup key.
  const secret = await shownSecret(page);
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  const link = page.getByRole('link', {
    name: 'On this phone? Open the authenticator app instead',
  });
  const uri = new URL(String(await link.getAttribute('href')));
  expect(uri.protocol).toBe('otpauth:');
  expect(uri.searchParams.get('secret')).toBe(secret);
  expect(uri.searchParams.get('issuer')).toBe('Paint Retail');
  expect(await qr.locator('path').getAttribute('d')).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
  expect(await accessibilityProblems(page)).toEqual([]);

  await page.getByRole('textbox', { name: '6-digit code' }).fill('000000');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong code. 4 tries left.');

  const { code, step } = await nextCode(secret, null);
  await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  const codes = page.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem');
  await expect(codes).toHaveCount(10);
  await expect(codes.first()).toHaveText(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(await accessibilityProblems(page)).toEqual([]);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download .txt' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('recovery-codes.txt');
  const file = readFileSync(await download.path(), 'utf8');
  for (const recoveryCode of await codes.allTextContents()) expect(file).toContain(recoveryCode);

  authenticators.set(business.ownerPhone, {
    secret,
    lastStep: step,
    recoveryCodes: await keepRecoveryCodes(page),
  });
  await expect(dashboard(page)).toBeVisible();

  // Account security now shows it on, and that the business requires it.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Account security' })
    .click();
  const account = page.getByRole('region', { name: 'Two-factor sign-in' });
  await expect(account.getByText('On', { exact: true })).toBeVisible();
  await expect(account.getByText('Recovery codes left: 10')).toBeVisible();
  await expect(account.getByText('Your business requires this for your role.')).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);
});

test('an owner signs in with a code from the app', async ({ page }) => {
  const business = await createBusiness('Code Paints');
  await addAuthenticator(business.ownerPhone, business.token);

  await submitPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
  expect(await accessibilityProblems(page)).toEqual([]);
  await enterAppCode(page, business.ownerPhone);
  await expect(dashboard(page)).toBeVisible();
  await expect(page.locator('.shell__business')).toHaveText('Code Paints');
});

test('an owner who lost their phone signs in with a recovery code, once', async ({ page }) => {
  const business = await createBusiness('Recovery Paints');
  const app = await addAuthenticator(business.ownerPhone, business.token);
  const recoveryCode = String(app.recoveryCodes[0]);

  await submitPassword(page, business.ownerPhone);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(recoveryCode.toUpperCase());
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(dashboard(page)).toBeVisible();

  await signOut(page);
  await submitPassword(page, business.ownerPhone);
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await page.getByRole('textbox', { name: 'Recovery code' }).fill(recoveryCode);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong code. 4 tries left.');
});

test('an expired two-factor step sends the person back to sign in', async ({ page }) => {
  const business = await createBusiness('Clock Paints');
  await addAuthenticator(business.ownerPhone, business.token);
  await page.clock.install();

  await submitPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
  // The pending sign-in lasts 5 minutes.
  await page.clock.fastForward('05:01');
  await expect(page.getByText('This sign-in has expired. Please sign in again.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '6-digit code' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in again' }).click();
  await expect(page.getByRole('textbox', { name: 'Mobile number or email' })).toBeVisible();
});

test('the business chooser comes before two-factor sign-in with a mobile code', async ({
  page,
}) => {
  const first = await createBusiness('Choice Paints');
  const second = await createBusiness('Other Colours');
  await addMember(second, 'branch_manager', { fullName: 'Anil Owner', phone: first.ownerPhone });

  await page.goto('/sign-in');
  await page.getByRole('tab', { name: 'Mobile code' }).click();
  await page.getByRole('textbox', { name: 'Mobile number' }).fill(first.ownerPhone.slice(3));
  await page.getByRole('button', { name: 'Send code' }).click();
  await page
    .getByRole('textbox', { name: '6-digit code' })
    .fill(await lastCodeFor(first.ownerPhone));
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  // The same code goes again with the choice; the owner's business then asks for the app.
  await page
    .getByRole('dialog', { name: 'Choose a business' })
    .getByRole('button', { name: 'Choice Paints' })
    .click();
  await expect(page.getByRole('heading', { name: 'Add an authenticator app' })).toBeVisible();
  const secret = await shownSecret(page);
  const { code } = await nextCode(secret, null);
  await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await keepRecoveryCodes(page);
  await expect(page.locator('.shell__business')).toHaveText('Choice Paints');
});

test('an owner relaxes the business rule, turns their app off and resets a member', async ({
  page,
}) => {
  const business = await createBusiness('Rules Paints');
  const phone = uniquePhone();
  await addMember(business, 'store_employee', { fullName: 'Suresh Counter', phone });
  await signInWithPassword(page, business.ownerPhone);
  await expect(dashboard(page)).toBeVisible();
  await page.goto('/settings/security');

  // Required for owners: turning it off is refused with the API's reason.
  const off = page.getByRole('form', { name: 'Turn off two-factor sign-in' });
  const app = authenticators.get(business.ownerPhone);
  const recoveryCode = String(app?.recoveryCodes[0]);
  await off
    .getByRole('textbox', { name: 'Code from the app or a recovery code' })
    .fill(recoveryCode);
  await off.getByRole('button', { name: 'Turn off' }).click();
  await expect(off.getByRole('alert')).toHaveText(
    'Your business requires two-factor sign-in for your role',
  );

  const rule = page.getByRole('checkbox', {
    name: 'Require two-factor sign-in for owners and admins',
  });
  await expect(rule).toBeChecked();
  await rule.uncheck();
  await expect(page.getByText('Sign-in rules saved')).toBeVisible();
  await expect(rule).not.toBeChecked();
  expect(
    await call<{ twoFactorRequired: boolean }>('GET', '/organization/security', {
      token: business.token,
    }),
  ).toEqual({ twoFactorRequired: false });

  await off
    .getByRole('textbox', { name: 'Code from the app or a recovery code' })
    .fill(String(app?.recoveryCodes[1]));
  await off.getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByText('Two-factor sign-in is off')).toBeVisible();
  const account = page.getByRole('region', { name: 'Two-factor sign-in' });
  await expect(account.getByRole('button', { name: 'Add an authenticator app' })).toBeVisible();

  // Resets live on each member's page under Team.
  await page
    .getByRole('region', { name: 'Team two-factor sign-in' })
    .getByRole('link', { name: 'Open the team' })
    .click();
  await page.getByRole('link', { name: 'Suresh Counter' }).click();
  await page
    .getByRole('region', { name: 'Two-factor sign-in' })
    .getByRole('button', { name: 'Reset two-factor' })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Reset two-factor sign-in for Suresh Counter?',
  });
  await dialog.getByRole('button', { name: 'Reset' }).click();
  await expect(page.getByText('Two-factor sign-in reset for Suresh Counter')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect(await accessibilityProblems(page)).toEqual([]);

  // With the rule off and no app, the owner signs in with the password alone.
  await signOut(page);
  await submitPassword(page, business.ownerPhone, PASSWORD);
  await expect(dashboard(page)).toBeVisible();
});

test('two-factor setup fits a phone screen @phone', async ({ page }) => {
  const business = await createBusiness('Pocket Paints');
  await submitPassword(page, business.ownerPhone);
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  // WCAG AA and no sideways scrolling, also with wider fonts than this machine's.
  await expectUsable(page);

  const secret = await shownSecret(page);
  const { code } = await nextCode(secret, null);
  await page.getByRole('textbox', { name: '6-digit code' }).fill(code);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('list', { name: 'Recovery codes' })).toBeVisible();
  await expectUsable(page);
  await keepRecoveryCodes(page);

  await page.locator('.shell__bottom-bar').getByRole('button', { name: 'More' }).click();
  await page
    .getByRole('dialog', { name: 'More' })
    .getByRole('link', { name: 'Account security' })
    .click();
  await expect(page.getByRole('heading', { name: 'Account security', level: 1 })).toBeVisible();
  await expectUsable(page);
});
