import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

// Billing (P2-M08): a business on its free trial upgrades to a paid plan by itself.
// The e2e API uses the fake payment gateway, whose checkout page is part of the app.

/** The operator's session, made by the global setup. */
const operatorToken = () =>
  (JSON.parse(String(process.env.E2E_PLATFORM_SESSION)) as { token: string }).token;

/** The e2e API signs businesses up on a paid plan; the platform puts this one on the trial. */
async function onTrial(business: Business): Promise<void> {
  const token = operatorToken();
  const found = await call<{ items: { id: string; name: string }[] }>(
    'GET',
    `/platform/tenants?q=${encodeURIComponent(business.name)}`,
    { token },
  );
  const id = String(found.items.find((item) => item.name === business.name)?.id);
  await call('PATCH', `/platform/tenants/${id}`, { token, body: { plan: 'trial' } });
}

test('a trial business upgrades to a paid plan by itself through the checkout', async ({
  page,
}) => {
  const business = await createBusiness(`Trial Upgrade Paints ${String(Date.now() % 1_000_000)}`);
  await onTrial(business);
  await signInWithPassword(page, business.ownerPhone);

  await page.goto('/settings/billing');
  const current = page.getByRole('region', { name: 'Your plan' });
  await expect(current).toContainText('Free trial');
  await expect(current).toContainText('14 days left');
  const plans = page.getByRole('region', { name: 'Plans' });
  await expect(plans).toContainText('You are billed for 2 stores.');
  await expect(plans.getByRole('button', { name: 'Upgrade: Starter' })).toBeDisabled();
  await expectUsable(page);

  await plans.getByRole('button', { name: 'Upgrade: Standard' }).click();
  await expect(page.getByRole('heading', { name: 'Pay for your plan' })).toBeVisible();
  await expect(page.getByText('Test payment – no money is taken')).toBeVisible();
  await expectUsable(page);
  await page.getByRole('button', { name: 'Pay ₹3,537.64' }).click();

  await expect(page.getByText('Payment received. Your plan is active.')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/billing$/);
  await expect(current).toContainText('Standard');
  await expect(current).toContainText('Active');
  await expect(current).toContainText('Paid online');
  await expect(plans.getByRole('button', { name: 'Current plan: Standard' })).toBeDisabled();
  const invoices = page.getByRole('table', { name: 'Our invoices to you' });
  await expect(invoices.getByRole('row')).toHaveCount(2);
  await expect(invoices).toContainText(/PRS\/\d{2}-\d{2}\/\d{6}/);
  await expect(invoices).toContainText('₹3,537.64');
  await expectUsable(page);
});
