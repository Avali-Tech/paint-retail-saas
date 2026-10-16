import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, signInWithPassword, type Business } from './support.js';

// Billing (P2-M08) with manual invoicing, the default: a business on its free trial
// asks for a plan, the platform's operator applies it, the owner sees our invoice
// with how to pay it, and the operator records the bank transfer in the console,
// which starts the plan. (The fake and Razorpay gateways have their own API tests.)

/** The operator's session, made by the global setup. */
const operatorSession = () =>
  JSON.parse(String(process.env.E2E_PLATFORM_SESSION)) as { token: string; expiresAt: string };

/** The business's id in the console, found by name. */
async function tenantId(business: Business): Promise<string> {
  const found = await call<{ items: { id: string; name: string }[] }>(
    'GET',
    `/platform/tenants?q=${encodeURIComponent(business.name)}`,
    { token: operatorSession().token },
  );
  return String(found.items.find((item) => item.name === business.name)?.id);
}

/** Starts the console signed in as the operator, as an earlier sign-in on this device would. */
async function openConsole(page: Page, path: string) {
  await page.goto('/platform/sign-in');
  await page.evaluate((session) => {
    localStorage.setItem('paint.platform-session', JSON.stringify(session));
  }, operatorSession());
  await page.goto(path);
}

test('a trial business asks for a plan, pays our invoice by bank transfer and is active', async ({
  page,
  context,
}) => {
  const business = await createBusiness(`Invoiced Paints ${String(Date.now() % 1_000_000)}`);
  const id = await tenantId(business);
  // The e2e API signs businesses up on a paid plan; the platform puts this one on the trial.
  await call('PATCH', `/platform/tenants/${id}`, {
    token: operatorSession().token,
    body: { plan: 'trial' },
  });
  await signInWithPassword(page, business.ownerPhone);

  await page.goto('/settings/billing');
  const current = page.getByRole('region', { name: 'Your plan' });
  await expect(current).toContainText('Free trial');
  const plans = page.getByRole('region', { name: 'Plans' });
  await expect(plans).toContainText('our team applies it and sends you our invoice');
  await expect(page.getByRole('region', { name: 'How to pay' })).toContainText('IFSC');
  await plans.getByRole('button', { name: 'Upgrade: Standard' }).click();
  await expect(current).toContainText('You asked for the Standard plan (Monthly)');
  await expect(plans.getByRole('button', { name: 'Requested: Standard' })).toBeDisabled();
  await expectUsable(page);

  // The operator applies the request in the console: our first invoice is raised.
  const operatorPage = await context.newPage();
  await openConsole(operatorPage, `/platform/tenants/${id}`);
  const billing = operatorPage.getByRole('region', { name: 'Invoices and payments' });
  await expect(billing).toContainText('Standard, Monthly: asked for by');
  await billing.getByRole('button', { name: 'Apply' }).click();
  const consoleInvoices = billing.getByRole('table', { name: 'Invoices to the business' });
  await expect(consoleInvoices).toContainText(/PRS\/\d{2}-\d{2}\/\d{6}/);
  await expect(consoleInvoices).toContainText('₹3,537.64');

  // The owner sees the invoice, unpaid, with where to send the money.
  await page.reload();
  const invoices = page.getByRole('table', { name: 'Our invoices to you' });
  await expect(invoices).toContainText('₹3,537.64');
  await expect(invoices).toContainText('Due');
  await expect(page.getByRole('region', { name: 'How to pay' })).toContainText(
    'quoting the invoice number as the reference',
  );
  await expect(current).toContainText('Free trial');
  await expectUsable(page);

  // The bank transfer arrives; the operator records it.
  await consoleInvoices.getByRole('button', { name: /^Record payment: PRS/ }).click();
  const dialog = operatorPage.getByRole('dialog');
  await dialog.getByLabel(/Reference/).fill('UTR HDFCR52026101600123');
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await expect(operatorPage.getByText(/^Payment recorded for PRS/)).toBeVisible();
  await expect(consoleInvoices).toContainText('Paid');
  await expectUsable(operatorPage);

  await page.reload();
  await expect(current).toContainText('Standard');
  await expect(current).toContainText('Active');
  await expect(current).toContainText('Our invoice, paid by bank transfer or UPI');
  await expect(invoices).toContainText('Paid');
  await expect(plans.getByRole('button', { name: 'Current plan: Standard' })).toBeDisabled();
  await expectUsable(page);
});
