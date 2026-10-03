import { crc32, deflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { expectUsable } from './checks.js';

import { createBusiness, signInWithPassword, uniquePhone } from './support.js';

const PRODUCTS_CSV = [
  'brand,product,type,hsn_code,gst_percent,sku,pack_size,unit,mrp,selling_price',
  'Asian Paints,Apex Ultima,exterior_paint,3209,18,APX-ULT-1L,1,l,650.00,610.00',
  'Asian Paints,Apex Ultima,exterior_paint,3209,18,APX-ULT-4L,4,l,2400.00,2300.00',
  'Berger,Easy Clean,interior_paint,3209,18,BEC-1L,1,l,520.00,',
].join('\r\n');

/** A minimal .xlsx: the parts Excel needs for one sheet of inline strings and numbers. */
function workbook(rows: readonly (readonly (string | number)[])[]): Buffer {
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const columns = 'ABCDEFGHIJ';
  const sheetRows = rows
    .map(
      (cells, rowIndex) =>
        `<row r="${String(rowIndex + 1)}">${cells
          .map((value, columnIndex) => {
            const ref = `${columns.charAt(columnIndex)}${String(rowIndex + 1)}`;
            return typeof value === 'number'
              ? `<c r="${ref}"><v>${String(value)}</v></c>`
              : `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
          })
          .join('')}</row>`,
    )
    .join('');
  const files: [string, string][] = [
    [
      'xl/workbook.xml',
      `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Stock" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="${ns}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    ],
  ];
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const plain = Buffer.from(text);
    const data = deflateRawSync(plain);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(plain), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(plain), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

async function chooseFile(page: Page, name: string, mimeType: string, buffer: Buffer) {
  await page.getByLabel('Spreadsheet', { exact: true }).setInputFiles({ name, mimeType, buffer });
}

test('imports products from a CSV after checking it', async ({ page }) => {
  const business = await createBusiness('Import Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/imports');
  await expect(page.getByRole('heading', { name: 'Import data', level: 1 })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Products and pack sizes' })).toBeChecked();
  await expectUsable(page);

  await chooseFile(page, 'products.csv', 'text/csv', Buffer.from(PRODUCTS_CSV));
  await expect(page.getByText('products.csv is ready to import')).toBeVisible();
  const plan = page.getByRole('table', { name: 'Rows in this file' });
  await expect(plan.getByRole('row')).toHaveCount(4);
  await expect(plan).toContainText('APX-ULT-1L');
  await expectUsable(page);

  await page.getByRole('button', { name: 'Import 3 rows' }).click();
  await expect(page.getByText(/Imported: 3 added, 0 updated/)).toBeVisible();
  await page.getByRole('link', { name: 'Open products' }).click();
  await expect(page.getByRole('link', { name: 'Apex Ultima' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Easy Clean' })).toBeVisible();
});

test('lists the problems in a bad file and will not import it', async ({ page }) => {
  const business = await createBusiness('Bad File Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/imports?kind=products');
  const bad = PRODUCTS_CSV.replace(
    'exterior_paint,3209,18,APX-ULT-4L',
    'emulsion,3209,18,APX-ULT-4L',
  );
  await chooseFile(page, 'bad.csv', 'text/csv', Buffer.from(bad));
  await expect(page.getByText('Problems in bad.csv: 1.', { exact: false })).toBeVisible();
  const problems = page.getByRole('table', { name: 'Problems by row' });
  await expect(problems.getByRole('row').nth(1)).toContainText('3type');
  await expect(page.getByRole('button', { name: 'Import 3 rows' })).toBeDisabled();
  await expectUsable(page);
});

test('imports opening stock from an Excel workbook', async ({ page }) => {
  const business = await createBusiness('Excel Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/imports');
  await chooseFile(page, 'products.csv', 'text/csv', Buffer.from(PRODUCTS_CSV));
  await page.getByRole('button', { name: 'Import 3 rows' }).click();
  await expect(page.getByText(/Imported: 3 added/)).toBeVisible();

  await page.getByRole('button', { name: 'Import another file' }).click();
  // The choice lives in the address, so the radio changes once the URL has.
  await page.getByRole('radio', { name: 'Opening stock per store' }).click();
  await expect(page.getByRole('radio', { name: 'Opening stock per store' })).toBeChecked();
  await expect(page).toHaveURL(/kind=opening-stock/);
  await chooseFile(
    page,
    'opening.xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    workbook([
      ['store', 'sku', 'quantity', 'unit_cost'],
      ['HYD', 'APX-ULT-1L', 24, 520],
      ['PUN', 'BEC-1L', 6, 410.5],
    ]),
  );
  await expect(page.getByText('opening.xlsx is ready to import')).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText(/Imported: 2 added/)).toBeVisible();
  await page.getByRole('link', { name: 'Open stock' }).click();
  await expect(page.getByRole('table', { name: 'Stock balances' })).toContainText('APX-ULT-1L');
});

test('imports customers and a supplier, and running the file again changes nothing', async ({
  page,
}) => {
  const business = await createBusiness('Party Import Paints');
  const csv = [
    'name,roles,phone,city,home_store',
    `Ramesh Painter,painter;customer,${uniquePhone()},Hyderabad,HYD`,
    `Shah Distributors,supplier,${uniquePhone()},Pune,`,
  ].join('\r\n');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/imports?kind=parties');
  await expect(
    page.getByRole('radio', { name: 'Customers, suppliers and other parties' }),
  ).toBeChecked();
  await chooseFile(page, 'parties.csv', 'text/csv', Buffer.from(csv));
  await expect(page.getByText('parties.csv is ready to import')).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText(/Imported: 2 added, 0 updated/)).toBeVisible();

  await page.getByRole('button', { name: 'Import another file' }).click();
  await chooseFile(page, 'parties.csv', 'text/csv', Buffer.from(csv));
  await expect(page.getByRole('table', { name: 'Rows in this file' })).toContainText('No change');
  await page.goto('/parties');
  await expect(page.getByRole('link', { name: 'Ramesh Painter' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Shah Distributors' })).toBeVisible();
});

test('the import screen fits a phone @phone', async ({ page }) => {
  const business = await createBusiness('Phone Import Paints');
  await signInWithPassword(page, business.ownerPhone);
  await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
  await page.goto('/imports');
  await expect(page.getByRole('heading', { name: 'Import data', level: 1 })).toBeVisible();
  await chooseFile(page, 'products.csv', 'text/csv', Buffer.from(PRODUCTS_CSV));
  await expect(page.getByText('products.csv is ready to import')).toBeVisible();
  await expectUsable(page);
});
