import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';
import { SCANNER_ON } from './env.js';
import { call, createBusiness, signInWithPassword } from './support.js';

// Uploads are scanned by ClamAV. By default the e2e stack runs without it, like
// `pnpm demo` without --clamav, so uploads are refused; E2E_CLAMAV=1 runs it.

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
);

async function openCustomer(page: Page, businessName: string) {
  const business = await createBusiness(businessName);
  const party = await call<{ id: string }>('POST', '/parties', {
    token: business.token,
    body: { displayName: 'Apex Builders', roles: ['customer'] },
  });
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto(`/parties/${party.id}`);
  const documents = page.getByRole('region', { name: 'Documents' });
  await expect(documents).toContainText('No documents yet');
  return documents;
}

test('uploads are checked first, and refused clearly while the virus scanner is off', async ({
  page,
}) => {
  test.skip(SCANNER_ON, 'The scanner is on (E2E_CLAMAV=1)');
  const documents = await openCustomer(page, 'Scanner-off Paints');
  await documents.getByRole('button', { name: 'Upload' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload a document' });
  const file = dialog.getByLabel(/^File/);
  const upload = dialog.getByRole('button', { name: 'Upload' });

  await file.setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await upload.click();
  await expect(dialog.getByText(/This kind of file is not accepted/)).toBeVisible();

  const tooBig = Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]);
  await file.setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: tooBig });
  await upload.click();
  await expect(dialog.getByText(/larger than 10 MB/)).toBeVisible();

  await file.setInputFiles({ name: 'gst.pdf', mimeType: 'application/pdf', buffer: PDF });
  await dialog.getByRole('combobox', { name: 'What it is' }).selectOption('gst_certificate');
  await upload.click();
  await expect(dialog.getByText(/The virus scanner is off or not working/)).toBeVisible();
  await expectUsable(page);
});

test('documents upload, download under their name and delete', async ({ page }) => {
  test.skip(!SCANNER_ON, 'Needs the virus scanner: run with E2E_CLAMAV=1');
  test.setTimeout(90_000);
  const documents = await openCustomer(page, 'Document Paints');
  await documents.getByRole('button', { name: 'Upload' }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload a document' });
  await dialog
    .getByLabel(/^File/)
    .setInputFiles({ name: 'gst certificate.pdf', mimeType: 'application/pdf', buffer: PDF });
  await dialog.getByRole('combobox', { name: 'What it is' }).selectOption('gst_certificate');
  await dialog.getByRole('textbox', { name: 'Note' }).fill('Valid till 2030');
  await dialog.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('Document uploaded')).toBeVisible();
  await expect(documents).toContainText('gst certificate.pdf');
  await expect(documents).toContainText('Valid till 2030');
  await expectUsable(page);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    documents.getByRole('button', { name: 'Download gst certificate.pdf' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('gst certificate.pdf');
  expect(readFileSync(await download.path()).equals(PDF)).toBe(true);

  await documents.getByRole('button', { name: 'Delete gst certificate.pdf' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Document deleted')).toBeVisible();
  await expect(documents).toContainText('No documents yet');
});

test('the documents panel and upload fit a phone @phone', async ({ page }) => {
  const documents = await openCustomer(page, 'Phone Document Paints');
  await expectUsable(page);
  await documents.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByRole('dialog', { name: 'Upload a document' })).toBeVisible();
  await expectUsable(page);
});
