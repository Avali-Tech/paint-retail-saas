import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { call, createBusiness, signInWithPassword, uniquePhone } from './support.js';

async function businessWithLeads(page: Page, name: string) {
  const business = await createBusiness(name);
  const [store] = business.stores;
  for (const [title, source] of [
    ['Villa repaint', 'walk_in'],
    ['Kondapur tower exterior', 'referral'],
  ] as const) {
    await call('POST', '/leads', {
      token: business.token,
      body: {
        storeId: store?.id,
        contact: { displayName: `${title} owner`, phone: uniquePhone() },
        title,
        source,
        estimatedValuePaise: 2_50_000_00,
      },
    });
  }
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  return business;
}

test('the owner filters a report and downloads it for Excel', async ({ page }) => {
  await businessWithLeads(page, 'Report Paints');
  await page
    .getByRole('navigation', { name: 'Main' })
    .first()
    .getByRole('link', { name: 'Reports' })
    .click();
  await expect(page.getByRole('region', { name: 'Stock by location' })).toBeVisible();
  await expectUsable(page);
  await page.getByRole('link', { name: 'Open Leads' }).click();

  const table = page.getByRole('table', { name: 'Leads' });
  await expect(table).toContainText('Villa repaint');
  await expect(table).toContainText('Kondapur tower exterior');
  await page.getByRole('combobox', { name: 'Source' }).selectOption('referral');
  await expect(table).not.toContainText('Villa repaint');
  await expect(table).toContainText('250000.00');
  await expectUsable(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^leads-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), 'utf8');
  // A BOM so Excel reads ₹, the headers, and only the filtered lead.
  expect(csv.startsWith('﻿Lead,')).toBe(true);
  expect(csv).toContain('Kondapur tower exterior');
  expect(csv).not.toContain('Villa repaint');
});

test('report filters come from the API, with their choices', async ({ page }) => {
  await businessWithLeads(page, 'Filter Report Paints');
  await page.goto('/reports/stock-ledger');
  const movement = page.getByRole('combobox', { name: 'Movement' });
  await expect(movement.getByRole('option', { name: 'Stock count correction' })).toBeAttached();
  await expect(page.getByLabel(/^From/)).toHaveAttribute('type', 'date');
  await page.goto('/reports/stock-by-location');
  // A yes/no filter, on by the API's default.
  await expect(page.getByRole('checkbox', { name: 'Only products in stock' })).toBeChecked();
  await page.goto('/reports/leads');
  const table = page.getByRole('table', { name: 'Leads' });
  await expect(table.getByRole('columnheader', { name: 'Estimated value (₹)' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Stage' }).selectOption({ label: 'Won' });
  await expect(page.getByText('Nothing matches these filters')).toBeVisible();
  await expectUsable(page);
});

test('reports fit a phone @phone', async ({ page }) => {
  await businessWithLeads(page, 'Phone Report Paints');
  await page.goto('/reports');
  await expect(page.getByRole('region', { name: 'Leads' })).toBeVisible();
  await expectUsable(page);
  await page.goto('/reports/leads');
  await expect(page.getByRole('table', { name: 'Leads' })).toContainText('Villa repaint');
  await expectUsable(page);
});
