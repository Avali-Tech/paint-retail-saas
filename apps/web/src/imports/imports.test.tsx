import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImportKind, ImportReport } from '../api/imports.js';
import { OWNER, json, profile, type FakeHandler } from '../test-support/fake-api.js';
import { renderApp } from '../test-support/render-app.js';
import { SHOWN_ROWS, templateCsv } from './ImportsPage.js';
import { workbookFiles, zip } from './test-support/zip.js';

const KINDS: ImportKind[] = [
  {
    kind: 'products',
    title: 'Products and pack sizes',
    permission: 'catalog:manage',
    columns: [
      { name: 'brand', required: true, description: 'Brand', example: 'Asian Paints' },
      { name: 'mrp', required: false, description: 'MRP in rupees', example: '650.00' },
    ],
  },
  {
    kind: 'parties',
    title: 'Parties',
    permission: 'parties:manage',
    columns: [{ name: 'name', required: true, description: 'Name', example: 'Shah' }],
  },
  {
    kind: 'opening-stock',
    title: 'Opening stock per store',
    permission: 'inventory:manage',
    columns: [{ name: 'store', required: true, description: 'Store code', example: 'HYD' }],
  },
];

const report = (overrides: Partial<ImportReport> = {}): ImportReport => ({
  kind: 'products',
  committed: false,
  valid: true,
  totals: { rows: 3, create: 1, update: 1, unchanged: 1, errors: 0 },
  rows: [
    { row: 2, action: 'create', label: 'APX-1L' },
    { row: 3, action: 'update', label: 'APX-4L' },
    { row: 4, action: 'unchanged', label: 'APX-10L' },
  ],
  errors: [],
  ...overrides,
});

const INVALID = report({
  valid: false,
  totals: { rows: 2, create: 0, update: 0, unchanged: 0, errors: 2 },
  rows: [],
  errors: [
    { row: 1, column: null, message: 'The file has no rows to import' },
    { row: 2, column: 'mrp', message: 'Enter an amount in rupees' },
  ],
});

function renderImports({
  path = '/imports',
  member = OWNER,
  kinds = KINDS,
  routes = {},
}: {
  path?: string;
  member?: typeof OWNER;
  kinds?: ImportKind[];
  routes?: Record<string, FakeHandler>;
} = {}) {
  return renderApp({
    path,
    routes: {
      'GET /auth/me': () => json(member),
      'GET /imports': () => json(kinds),
      'POST /imports/:kind/preview': () => json(report()),
      ...routes,
    },
  });
}

const fileInput = () => screen.getByLabelText(/^Spreadsheet/);
const csvFile = (text = 'brand\nAsian Paints\n', name = 'products.csv') =>
  new File([text], name, { type: 'text/csv' });

// jsdom cannot hand out object URLs for downloads.
const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:template');
const revokeObjectURL = vi.fn<(url: string) => void>();

beforeEach(() => {
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('templateCsv', () => {
  it('has the columns and the example row, with a byte order mark for Excel', () => {
    const [products] = KINDS;
    expect(products && templateCsv(products)).toBe('﻿brand,mrp\r\nAsian Paints,650.00\r\n');
  });
});

describe('ImportsPage', () => {
  it('offers each kind with its columns and a template to download', async () => {
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const { user } = renderImports();
    const kinds = await screen.findByRole('group', { name: 'What to import' });
    expect(
      within(kinds)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual([
      'Products and pack sizes',
      'Customers, suppliers and other parties',
      'Opening stock per store',
    ]);
    expect(screen.getByRole('radio', { name: 'Products and pack sizes' })).toBeChecked();
    const columns = screen.getByRole('table', { name: 'Columns for Products and pack sizes' });
    expect(
      within(columns)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'ColumnWhat to enterExample',
      'brandRequiredBrandAsian Paints',
      'mrpOptionalMRP in rupees650.00',
    ]);

    await user.click(screen.getByRole('button', { name: 'Download template' }));
    expect(click).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob instanceof Blob ? await blob.text() : null).toBe(
      'brand,mrp\r\nAsian Paints,650.00\r\n',
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:template');

    await user.click(screen.getByRole('radio', { name: 'Opening stock per store' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/imports?kind=opening-stock');
    expect(
      screen.getByRole('table', { name: 'Columns for Opening stock per store' }),
    ).toHaveTextContent('Store code');
  });

  it('checks a CSV, then imports it and links to what was imported', async () => {
    const commit = vi.fn(() => json(report({ committed: true })));
    const { user, requests } = renderImports({ routes: { 'POST /imports/:kind': commit } });
    await user.upload(
      await screen.findByLabelText(/^Spreadsheet/),
      csvFile('﻿brand\nAsian Paints\n'),
    );

    expect(
      await screen.findByText('products.csv is ready to import: nothing has been saved yet.'),
    ).toBeInTheDocument();
    const preview = requests.find((request) => request.path === '/imports/products/preview');
    expect(preview?.body).toEqual({ csv: 'brand\nAsian Paints\n' });
    expect(screen.getByLabelText('What this file would do')).toHaveTextContent(
      'Rows3To add1To update1Unchanged1Errors0',
    );
    const plan = screen.getByRole('table', { name: 'Rows in this file' });
    expect(
      within(plan)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['RowActionRecord', '2AddAPX-1L', '3UpdateAPX-4L', '4No changeAPX-10L']);
    expect(screen.queryByRole('table', { name: 'Problems by row' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Import 3 rows' }));
    expect(
      await screen.findByText('Imported: 1 added, 1 updated, 1 unchanged.'),
    ).toBeInTheDocument();
    expect(commit).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Open products' })).toHaveAttribute(
      'href',
      '/products',
    );
    expect(screen.getByText('Import finished')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Import another file' }));
    expect(fileInput()).toHaveValue('');
    expect(screen.queryByRole('button', { name: /^Import \d/ })).toBeNull();
  });

  it('turns an Excel workbook into CSV before checking it', async () => {
    const { user, requests } = renderImports({ path: '/imports?kind=opening-stock' });
    const bytes = await zip(
      workbookFiles({
        sheet:
          '<row r="1"><c r="A1" t="inlineStr"><is><t>store</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>HYD</t></is></c></row>',
      }),
    );
    await user.upload(
      await screen.findByLabelText(/^Spreadsheet/),
      new File([bytes], 'stock.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );
    await screen.findByText(/stock.xlsx is ready/);
    expect(
      requests.find((request) => request.path === '/imports/opening-stock/preview')?.body,
    ).toEqual({ csv: 'store\r\nHYD\r\n' });
  });

  it('lists the problems and will not import a file with errors', async () => {
    const many = report({
      valid: false,
      totals: {
        rows: SHOWN_ROWS + 1,
        create: SHOWN_ROWS + 1,
        update: 0,
        unchanged: 0,
        errors: SHOWN_ROWS + 1,
      },
      rows: Array.from({ length: SHOWN_ROWS + 1 }, (_, index) => ({
        row: index + 2,
        action: 'create' as const,
        label: `SKU-${String(index)}`,
      })),
      errors: Array.from({ length: SHOWN_ROWS + 1 }, (_, index) => ({
        row: index + 2,
        column: 'sku',
        message: 'Also on row 2',
      })),
    });
    const { user } = renderImports({
      routes: {
        'POST /imports/:kind/preview': (request) =>
          json((request.body as { csv: string }).csv.includes('many') ? many : INVALID),
      },
    });
    await user.upload(await screen.findByLabelText(/^Spreadsheet/), csvFile());
    expect(
      await screen.findByText(
        'Problems in products.csv: 2. Fix them in the spreadsheet and choose it again.',
      ),
    ).toBeInTheDocument();
    const problems = screen.getByRole('table', { name: 'Problems by row' });
    expect(
      within(problems)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      'RowColumnProblem',
      '1Whole rowThe file has no rows to import',
      '2mrpEnter an amount in rupees',
    ]);
    expect(screen.getByRole('button', { name: 'Import 2 rows' })).toBeDisabled();

    await user.upload(fileInput(), csvFile('many\n'));
    expect(
      await screen.findAllByText(
        `Showing the first ${String(SHOWN_ROWS)} of ${String(SHOWN_ROWS + 1)}.`,
      ),
    ).toHaveLength(2);
    expect(
      within(screen.getByRole('table', { name: 'Rows in this file' })).getAllByRole('row'),
    ).toHaveLength(SHOWN_ROWS + 1);
  });

  it('shows the report when the import is refused, and other failures as they are', async () => {
    let answer = json({ statusCode: 400, message: 'Nothing was imported', report: INVALID }, 400);
    const { user } = renderImports({ routes: { 'POST /imports/:kind': () => answer } });
    await user.upload(await screen.findByLabelText(/^Spreadsheet/), csvFile());
    await user.click(await screen.findByRole('button', { name: 'Import 3 rows' }));
    expect(
      await screen.findByText('Nothing was imported. Fix the rows with errors and try again.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Problems by row' })).toHaveTextContent(
      'Enter an amount in rupees',
    );
    expect(screen.getByRole('button', { name: 'Import 2 rows' })).toBeDisabled();

    answer = json({ statusCode: 500, message: 'Database is down' }, 500);
    await user.upload(fileInput(), csvFile());
    await user.click(await screen.findByRole('button', { name: 'Import 3 rows' }));
    expect(await screen.findByText('Database is down')).toBeInTheDocument();
  });

  it('explains files it cannot read and checks that fail', async () => {
    const { user } = renderImports({
      routes: {
        'POST /imports/:kind/preview': () => json({ statusCode: 503, message: 'Try later' }, 503),
      },
    });
    const input = await screen.findByLabelText(/^Spreadsheet/);
    await user.upload(input, csvFile());
    expect(await screen.findByText('Try later')).toBeInTheDocument();

    // (user.upload cannot pick a file its accept list leaves out.)
    fireEvent.change(input, { target: { files: [new File(['x'], 'old.xls')] } });
    expect(
      await screen.findByText(
        'Old Excel (.xls) and other formats cannot be read. Save it as CSV or .xlsx.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Try later')).toBeNull();
    expect(input).toHaveAttribute('aria-invalid', 'true');

    // Cancelling the file picker clears what was there.
    fireEvent.change(input, { target: { files: [] } });
    await waitFor(() => {
      expect(input).not.toHaveAttribute('aria-invalid');
    });
  });

  it('offers only the kinds the member may import', async () => {
    const kinds: ImportKind[] = [
      ...KINDS,
      { kind: 'secret', title: 'Secret', permission: 'platform:everything', columns: [] },
      {
        kind: 'suppliers',
        title: 'Suppliers from the API',
        permission: 'inventory:manage',
        columns: [],
      },
    ];
    const { user } = renderImports({
      member: profile(['stores:read', 'inventory:manage']),
      kinds,
      routes: { 'POST /imports/:kind': () => json(report({ committed: true })) },
    });
    const group = await screen.findByRole('group', { name: 'What to import' });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Opening stock per store' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: 'Suppliers from the API' }));
    await user.upload(fileInput(), csvFile());
    await user.click(await screen.findByRole('button', { name: 'Import 3 rows' }));
    await screen.findByText('Imported: 1 added, 1 updated, 1 unchanged.');
    expect(screen.queryByRole('link', { name: /^Open/ })).toBeNull();
  });

  it('says when there is nothing the member may import', async () => {
    renderImports({ member: profile(['stores:read', 'parties:manage']), kinds: KINDS.slice(0, 1) });
    expect(await screen.findByText('Nothing to import with your role')).toBeInTheDocument();
  });

  it('is closed to members who cannot import anything', async () => {
    renderImports({ member: profile(['stores:read', 'catalog:read']) });
    expect(await screen.findByText('No access')).toBeInTheDocument();
  });

  it('offers to try again when the kinds cannot be loaded', async () => {
    renderImports({
      routes: { 'GET /imports': () => json({ statusCode: 500, message: 'Down' }, 500) },
    });
    expect(await screen.findByText('Could not load the import types')).toBeInTheDocument();
  });
});
