import { expect, test } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, openFromMenu, signInWithPassword } from './support.js';

/** A calendar day in India, `days` from today (YYYY-MM-DD). */
function indiaDay(days: number): string {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const moment = new Date(`${today}T00:00:00Z`);
  moment.setUTCDate(moment.getUTCDate() + days);
  return moment.toISOString().slice(0, 10);
}

test('an owner records a contract, activates it, renews it and terminates the renewal', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const business = await createBusiness('Contract Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Apex Builders', roles: ['contractor'] },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await openFromMenu(page, 'Customers', 'Contracts');
  await expect(page.getByText('No contracts yet')).toBeVisible();
  await page.getByRole('link', { name: '+ Contract' }).click();

  await page.getByRole('searchbox', { name: 'Search by name, mobile or GSTIN' }).fill('apex');
  await page.getByRole('button', { name: 'Choose Apex Builders' }).click();
  await page.getByRole('combobox', { name: 'Type' }).selectOption('contractor_agreement');
  await page.getByRole('textbox', { name: 'Title' }).fill('Painting contract');
  await page.getByLabel(/^Start date/).fill(indiaDay(0));
  // Ends in 20 days, so its renewal is due as soon as it is active.
  await page.getByLabel(/^End date/).fill(indiaDay(20));
  await page.getByRole('textbox', { name: 'Value (₹)' }).fill('2,50,000');
  await page.getByRole('textbox', { name: 'Terms', exact: true }).fill('12% below MRP');
  await expectUsable(page);
  await page.getByRole('button', { name: 'Save as draft' }).click();

  await expect(
    page.getByRole('heading', { name: 'CT-000001 · Painting contract', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Details' })).toContainText('₹2,50,000.00');
  await expect(page.getByRole('region', { name: 'Documents' })).toContainText('No documents yet');
  await page.getByRole('button', { name: 'Activate' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByText('Contract activated')).toBeVisible();
  await expect(page.getByText('Renewal due', { exact: true })).toBeVisible();
  await expectUsable(page);

  // The renewals coming up in 30 days include it.
  await page.goto('/contracts?renewalDue=30');
  const table = page.getByRole('table', { name: 'Contracts' });
  await expect(table).toContainText('CT-000001');
  await expect(table).toContainText('Apex Builders');
  await expectUsable(page);

  await table.getByRole('link', { name: 'CT-000001' }).click();
  await page.getByRole('button', { name: 'Renew' }).click();
  const renew = page.getByRole('dialog', { name: 'Renew CT-000001' });
  await renew.getByLabel(/^End date/).fill(indiaDay(386));
  await renew.getByRole('button', { name: 'Renew' }).click();
  await expect(page.getByText('Renewed as CT-000002')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'CT-000002 · Painting contract', level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Details' }).getByRole('link', { name: 'CT-000001' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Terminate' }).click();
  const terminate = page.getByRole('dialog', { name: 'Terminate CT-000002?' });
  await terminate.getByRole('textbox', { name: 'Reason' }).fill('Contractor moved away');
  await terminate.getByRole('button', { name: 'Terminate' }).click();
  await expect(page.getByText('Contract terminated')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Details' })).toContainText(
    'Contractor moved away',
  );

  // The customer 360 links to its contracts.
  await page.goto(`/parties/${party.id}`);
  await page
    .getByRole('region', { name: 'Contracts' })
    .getByRole('link', { name: /CT-000001/ })
    .click();
  await expect(
    page.getByRole('heading', { name: 'CT-000001 · Painting contract', level: 1 }),
  ).toBeVisible();
});

test('contracts fit a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Contract Paints');
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Sri Venkateswara Builders and Developers', roles: ['contractor'] },
  });
  const contract = await call<{ id: string }>('POST', '/contracts', {
    token: business.token,
    body: {
      type: 'contractor_agreement',
      title: 'Annual painting and waterproofing contract for the Kondapur towers',
      partyId: party.id,
      startDate: indiaDay(0),
      endDate: indiaDay(365),
      valuePaise: 12_50_00_000,
      terms: 'Paint supplied at 12% below MRP. Delivery within 3 days of each order.',
    },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/contracts');
  await expect(page.getByRole('table', { name: 'Contracts' })).toContainText('CT-000001');
  await expectUsable(page);
  await page.goto(`/contracts/${contract.id}`);
  await expect(page.getByRole('region', { name: 'Terms' })).toContainText('12% below MRP');
  await expectUsable(page);
  await page.goto(`/contracts/${contract.id}/edit`);
  await expect(page.getByRole('textbox', { name: 'Value (₹)' })).toHaveValue('1250000.00');
  await expectUsable(page);
});
