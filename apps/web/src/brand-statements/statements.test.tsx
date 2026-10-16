import type { BrandStatementDetail, SchemeSummary, StatementTemplateInput } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import {
  DETAIL,
  LINES,
  PREVIEW,
  SIGNED_TEMPLATE,
  SUMMARY,
  TEMPLATE,
} from '../test-support/statement-fixtures.js';
import { signedPaise } from './UploadPage.js';

// Brand statement reconciliation (P2-M34): the list, templates and their editor, the
// upload with its preview, and the reconciliation screen with members' matches.

const BUYER = profile(['stores:read', 'catalog:read', 'purchasing:read'], {
  role: { key: 'inventory_manager', name: 'Inventory Manager' },
  allStores: false,
});

const SUPPLIERS = {
  items: [
    { id: 'sup-deccan', name: 'Deccan Distributors' },
    { id: 'sup-plain', name: 'Plain Distributors' },
  ],
  total: 2,
};
const BRANDS = [{ id: 'brand-apex', name: 'Apex Paints', isActive: true }];

const location = () => screen.getByTestId('location').textContent;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StatementsPage', { timeout: 30_000 }, () => {
  it('lists the statements with their mismatches, and the discarded ones on request', async () => {
    const { user, requests } = renderApp({
      path: '/brand-statements',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements': (request) =>
          json(
            request.query.get('status') === 'discarded'
              ? []
              : [
                  SUMMARY,
                  { ...SUMMARY, id: 'bs-2', number: 'BS-000002', brand: null, mismatches: 0 },
                ],
          ),
      },
    });
    const table = await screen.findByRole('table', { name: 'Brand statements' });
    const first = found(within(table).getByText('BS-000001').closest('tr'));
    expect(within(first).getByText('· Apex Paints')).toBeVisible();
    expect(within(first).getByText('3')).toBeVisible();
    expect(within(table).getByText('BS-000002')).toHaveAttribute('href', '/brand-statements/bs-2');
    expect(screen.getByRole('link', { name: 'Upload a statement' })).toBeVisible();
    await user.click(screen.getByLabelText('Show discarded statements'));
    expect(await screen.findByText(/No brand statement yet/)).toBeVisible();
    expect(requests.some((request) => request.query.get('status') === 'discarded')).toBe(true);
  });

  it('offers no upload to members who only see purchasing', async () => {
    renderApp({
      path: '/brand-statements',
      routes: {
        'GET /auth/me': () => json(BUYER),
        'GET /brand-statements': () => json([SUMMARY]),
      },
    });
    expect(await screen.findByText('BS-000001')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Upload a statement' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Statement templates' })).toBeVisible();
  });
});

describe('TemplatesPage', { timeout: 30_000 }, () => {
  it('lists the templates, links them to their editor, and says when there is none', async () => {
    renderApp({
      path: '/brand-statements/templates',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/templates': () => json([TEMPLATE, SIGNED_TEMPLATE]),
      },
    });
    const table = await screen.findByRole('table', { name: 'Statement templates' });
    expect(within(table).getByRole('link', { name: 'Change Deccan ledger' })).toHaveAttribute(
      'href',
      '/brand-statements/templates/tpl-deccan/edit',
    );
    expect(within(table).getByText('Switched off')).toBeVisible();
    expect(within(table).getByText('No brand')).toBeVisible();
    expect(within(table).getAllByText('Within 7 days and ₹1.00')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'New template' })).toBeVisible();
  });

  it('shows names only to members who cannot change templates', async () => {
    renderApp({
      path: '/brand-statements/templates',
      routes: {
        'GET /auth/me': () => json(BUYER),
        'GET /brand-statements/templates': () => json([TEMPLATE]),
      },
    });
    expect(await screen.findByText('Deccan ledger')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Change Deccan ledger' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'New template' })).toBeNull();
  });

  it('says when there is no template yet', async () => {
    renderApp({
      path: '/brand-statements/templates',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/templates': () => json([]),
      },
    });
    expect(await screen.findByText('No template yet.')).toBeVisible();
  });
});

describe('the template editor', { timeout: 30_000 }, () => {
  it('makes a template, checking each field first', async () => {
    let sent: StatementTemplateInput | null = null;
    let answers = 0;
    const { user } = renderApp({
      path: '/brand-statements/templates/new',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /suppliers': () => json(SUPPLIERS),
        'GET /brands': () => json(BRANDS),
        'GET /brand-statements/templates': () => json([TEMPLATE]),
        'POST /brand-statements/templates': (request) => {
          answers += 1;
          sent = request.body as StatementTemplateInput;
          return answers === 1
            ? json({ statusCode: 409, message: 'A template of that name already exists' }, 409)
            : json(TEMPLATE, 201);
        },
      },
    });
    await screen.findByRole('heading', { name: 'New statement template' });
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findAllByText('Enter this')).toHaveLength(2);
    await user.type(screen.getByLabelText('Template name'), 'Deccan ledger');
    await user.selectOptions(await screen.findByLabelText('Supplier'), 'sup-deccan');
    await user.selectOptions(
      screen.getByLabelText('Brand of its scheme credit notes'),
      'brand-apex',
    );
    await user.clear(screen.getByLabelText('Rows above the headings'));
    await user.type(screen.getByLabelText('Rows above the headings'), '99');
    await user.clear(screen.getByLabelText('Dates may differ by (days)'));
    await user.type(screen.getByLabelText('Dates may differ by (days)'), '70');
    await user.clear(screen.getByLabelText('Amounts may differ by (₹)'));
    await user.type(screen.getByLabelText('Amounts may differ by (₹)'), '5000');
    await user.selectOptions(screen.getByLabelText('Amounts are in'), 'signed');
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Enter 0 to 50')).toBeVisible();
    expect(screen.getByText('Enter 0 to 60 days')).toBeVisible();
    expect(screen.getByText('Enter ₹0 to ₹1,000')).toBeVisible();
    expect(screen.getByText('Enter this')).toBeVisible();

    await user.clear(screen.getByLabelText('Rows above the headings'));
    await user.type(screen.getByLabelText('Rows above the headings'), '1');
    await user.clear(screen.getByLabelText('Dates may differ by (days)'));
    await user.type(screen.getByLabelText('Dates may differ by (days)'), '5');
    await user.clear(screen.getByLabelText('Amounts may differ by (₹)'));
    await user.type(screen.getByLabelText('Amounts may differ by (₹)'), '10');
    await user.type(screen.getByLabelText('Amount column'), 'Amount');
    await user.selectOptions(screen.getByLabelText('In the amount column'), 'credit_positive');
    await user.selectOptions(screen.getByLabelText('Dates are written'), 'dd-mon-yyyy');
    await user.selectOptions(screen.getByLabelText('Compare GRNs'), 'taxable');
    await user.type(screen.getByLabelText('Reference column (optional)'), 'Ref');
    await user.clear(screen.getByLabelText('Words for Debit note'));
    await user.click(screen.getByLabelText('Use this template for new statements'));
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('A template of that name already exists')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Template saved')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe('/brand-statements/templates');
    });
    expect(sent).toMatchObject({
      name: 'Deccan ledger',
      supplierPartyId: 'sup-deccan',
      brandId: 'brand-apex',
      headerRowsToSkip: 1,
      referenceColumn: 'Ref',
      amountMode: 'signed',
      debitColumn: null,
      amountColumn: 'Amount',
      signConvention: 'credit_positive',
      dateFormat: 'dd-mon-yyyy',
      dateWindowDays: 5,
      amountTolerancePaise: 1_000,
      grnAmountBasis: 'taxable',
      isActive: false,
    });
    expect(found(sent as StatementTemplateInput | null).typeRules).not.toHaveProperty('debit_note');
  });

  it('changes a template, keeping its supplier', async () => {
    let sent: unknown = null;
    const { user } = renderApp({
      path: '/brand-statements/templates/tpl-deccan/edit',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /suppliers': () => json(SUPPLIERS),
        'GET /brands': () => json(BRANDS),
        'GET /brand-statements/templates': () => json([TEMPLATE]),
        'PUT /brand-statements/templates/:id': (request) => {
          sent = request.body;
          return json(TEMPLATE);
        },
      },
    });
    const name = await screen.findByLabelText('Template name');
    expect(name).toHaveValue('Deccan ledger');
    expect(screen.getByLabelText('Supplier')).toBeDisabled();
    expect(screen.getByLabelText('Debit column')).toHaveValue('Debit');
    await user.type(screen.getByLabelText('Narration column (optional)'), ' text');
    await user.type(screen.getByLabelText('Type column (optional)'), 's');
    await user.clear(screen.getByLabelText('Credit column'));
    await user.type(screen.getByLabelText('Credit column'), 'Cr');
    await user.clear(screen.getByLabelText('Date column'));
    await user.type(screen.getByLabelText('Date column'), 'Txn Date');
    await user.click(screen.getByRole('button', { name: 'Save template' }));
    expect(await screen.findByText('Template saved')).toBeVisible();
    expect(sent).toMatchObject({
      creditColumn: 'Cr',
      dateColumn: 'Txn Date',
      typeColumn: 'Types',
      descriptionColumn: 'Narration text',
    });
  });

  it('says when the template cannot be found', async () => {
    renderApp({
      path: '/brand-statements/templates/missing/edit',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/templates': () => json([TEMPLATE]),
      },
    });
    expect(await screen.findByText('Could not load the template')).toBeVisible();
  });
});

describe('the upload', { timeout: 30_000 }, () => {
  const file = () => new File(['Date,Doc No\r\n'], 'July.csv', { type: 'text/csv' });

  it('checks the file, shows what it would import, imports it and opens the reconciliation', async () => {
    const previews = [
      { ...PREVIEW, duplicateOf: 'BS-000001' },
      {
        ...PREVIEW,
        lines: Array.from({ length: 60 }, (_, index) => ({
          ...PREVIEW.lines[1],
          rowNumber: index + 2,
          documentNumber: index === 0 ? null : `AD/${String(index)}`,
        })),
      },
    ] as const;
    let previewsAsked = 0;
    let imported: FormData | null = null;
    const { user } = renderApp({
      path: '/brand-statements/upload',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/templates': () => json([TEMPLATE, SIGNED_TEMPLATE]),
        'POST /brand-statements/preview': () => {
          previewsAsked += 1;
          return json(previews[previewsAsked - 1]);
        },
        'POST /brand-statements': (request) => {
          imported = request.body as FormData;
          return json(DETAIL, 201);
        },
        'GET /brand-statements/:id': () => json(DETAIL),
      },
    });
    await screen.findByRole('option', { name: /Deccan ledger/ });
    const templateSelect = screen.getByLabelText('Template');
    // Switched-off templates are not offered.
    expect(within(templateSelect).queryByText(/Plain ledger/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findAllByText('Choose a template')).toHaveLength(2);
    await user.selectOptions(templateSelect, 'tpl-deccan');
    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText('Choose the statement file')).toBeVisible();
    // Choosing no file after one clears it.
    await user.upload(screen.getByLabelText('Statement file'), file());
    await user.upload(screen.getByLabelText('Statement file'), []);
    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText('Choose the statement file')).toBeVisible();
    await user.upload(screen.getByLabelText('Statement file'), file());
    await user.type(screen.getByLabelText('Opening balance as printed (₹, optional)'), 'ten');
    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText(/Enter an amount in rupees/)).toBeVisible();
    await user.clear(screen.getByLabelText('Opening balance as printed (₹, optional)'));
    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText('This file is already imported as BS-000001.')).toBeVisible();
    expect(screen.getByText(/7 lines from/)).toBeVisible();
    expect(screen.getByText('Rows left out (totals, blank amounts)')).toBeVisible();
    expect(screen.getByText('Total 77,250.00')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText('The first 50 of 60 lines are shown.')).toBeVisible();

    await user.type(screen.getByLabelText('Period from (optional)'), '2026-07-01');
    await user.type(screen.getByLabelText('Period to (optional)'), '2026-07-31');
    await user.type(screen.getByLabelText('Opening balance as printed (₹, optional)'), '-1,000.50');
    await user.type(screen.getByLabelText('Closing balance as printed (₹, optional)'), '2500');
    await user.click(screen.getByRole('button', { name: 'Import and match' }));
    expect(await screen.findByText('Statement imported and matched')).toBeVisible();
    await waitFor(() => {
      expect(location()).toBe('/brand-statements/bs-1');
    });
    const form = found(imported as FormData | null, 'form');
    expect(form.get('templateId')).toBe('tpl-deccan');
    expect(form.get('periodFrom')).toBe('2026-07-01');
    expect(form.get('periodTo')).toBe('2026-07-31');
    expect(form.get('openingBalancePaise')).toBe('-100050');
    expect(form.get('closingBalancePaise')).toBe('250000');
    expect((form.get('file') as File).name).toBe('July.csv');
  });

  it('shows the rows a refused file could not read, and says when there is no template', async () => {
    const { user } = renderApp({
      path: '/brand-statements/upload',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/templates': () => json([TEMPLATE]),
        'POST /brand-statements': () =>
          json(
            {
              statusCode: 400,
              code: 'statement_rows',
              message: 'Nothing was imported: the file has rows the template cannot read',
              preview: {
                ...PREVIEW,
                valid: false,
                lines: [],
                skipped: [],
                errors: [
                  {
                    row: 0,
                    column: null,
                    message: 'The file has no lines with a date and an amount',
                  },
                  { row: 4, column: 'Date', message: '"xx" is not a date written DD-MM-YYYY' },
                ],
              },
            },
            400,
          ),
        'POST /brand-statements/preview': () =>
          json(
            {
              statusCode: 400,
              code: 'statement_file',
              message: 'PDF statements cannot be read yet',
            },
            400,
          ),
      },
    });
    await screen.findByRole('option', { name: /Deccan ledger/ });
    await user.selectOptions(screen.getByLabelText('Template'), 'tpl-deccan');
    await user.upload(screen.getByLabelText('Statement file'), file());
    await user.click(screen.getByRole('button', { name: 'Check the file' }));
    expect(await screen.findByText('PDF statements cannot be read yet')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Import and match' }));
    expect(await screen.findByText(/Nothing was imported/)).toBeVisible();
    expect(screen.getByText('Rows the template cannot read')).toBeVisible();
    expect(screen.getByText('The whole file')).toBeVisible();
    expect(screen.getByText('Row 4')).toBeVisible();
  });

  it('asks for a template first when there is none', async () => {
    renderApp({
      path: '/brand-statements/upload',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/templates': () => json([SIGNED_TEMPLATE]),
      },
    });
    expect(await screen.findByText('Make a statement template first.')).toBeVisible();
  });

  it('reads signed rupee amounts', () => {
    expect(signedPaise(' ')).toBeUndefined();
    expect(signedPaise('-12.50')).toBe(-1_250);
    expect(signedPaise('12')).toBe(1_200);
    expect(signedPaise('x')).toBeNull();
  });
});

describe('the reconciliation', { timeout: 30_000 }, () => {
  const schemes: SchemeSummary[] = [
    { scheme: { id: 'scheme-1', name: 'Monsoon slab', status: 'active' } } as SchemeSummary,
    { scheme: { id: 'scheme-2', name: 'Old draft', status: 'draft' } } as SchemeSummary,
  ];

  it('shows both sides, the figures, and filters the lines', async () => {
    const { user } = renderApp({
      path: '/brand-statements/bs-1',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/:id': () => json(DETAIL),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'BS-000001: Deccan Distributors' }),
    ).toBeVisible();
    const summary = screen.getByRole('region', { name: 'The period’s figures' });
    expect(within(summary).getByText(/44,850\.00/)).toBeVisible();
    expect(within(summary).getByText('Our records not on the statement (2)')).toBeVisible();
    expect(within(summary).getByText('Closing balance printed')).toBeVisible();
    expect(within(summary).getByText(/Payments to suppliers are recorded/)).toBeVisible();
    const brand = screen.getByRole('table', { name: 'The brand’s statement' });
    // The opening balance is a figure, not a line to match.
    expect(within(brand).getAllByRole('row')).toHaveLength(LINES.length);
    const partial = found(within(brand).getByText('AD/105').closest('tr'));
    expect(within(partial).getByText('Amount differs')).toBeVisible();
    expect(within(partial).getByText('by Suma Owner')).toBeVisible();
    expect(within(partial).getByText('differs by ₹250.00')).toBeVisible();
    expect(within(partial).getByText('Note: Freight added')).toBeVisible();
    const auto = found(within(brand).getByText('AD/104').closest('tr'));
    expect(within(auto).getByText('by the matching')).toBeVisible();
    expect(within(auto).getByText(/· Ultima 20 L/)).toBeVisible();
    const ours = screen.getByRole('table', { name: 'Our books' });
    expect(within(ours).getByText('Row 4')).toBeVisible();
    expect(within(ours).getAllByText('Not on the statement')).toHaveLength(2);
    expect(within(ours).getByText('Outside the period')).toBeVisible();
    expect(within(ours).getByText('On another statement')).toBeVisible();

    await user.selectOptions(screen.getByLabelText('Show'), 'problems');
    expect(within(brand).getAllByRole('row')).toHaveLength(4);
    await user.selectOptions(screen.getByLabelText('Show'), 'explained');
    expect(
      within(screen.getByRole('table', { name: 'The brand’s statement' })).getAllByRole('row'),
    ).toHaveLength(2);
    await user.selectOptions(screen.getByLabelText('Show'), 'matched');
    await user.selectOptions(screen.getByLabelText('Show'), 'untracked');
    await user.selectOptions(screen.getByLabelText('Show'), 'partial');
    expect(screen.getByRole('table', { name: 'The brand’s statement' })).toBeVisible();
  });

  it('matches by hand, explains, records a scheme credit note and unmatches', async () => {
    const after = (status: string): BrandStatementDetail => ({
      ...DETAIL,
      lines: DETAIL.lines.map((line) =>
        line.id === 'l-missing' ? { ...line, status: status as 'matched' } : line,
      ),
    });
    const sent: { path: string; method: string; body: unknown }[] = [];
    const record = (request: { path: string; method: string; body: unknown }) => {
      sent.push({ path: request.path, method: request.method, body: request.body });
    };
    const { user } = renderApp({
      path: '/brand-statements/bs-1',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/:id': () => json(DETAIL),
        'GET /brand-schemes': () => json(schemes),
        'POST /brand-statements/bs-1/lines/:lineId/match': (request) => {
          record(request);
          return json(after('matched'));
        },
        'POST /brand-statements/bs-1/lines/:lineId/explain': (request) => {
          record(request);
          return json(after('explained'));
        },
        'POST /brand-statements/bs-1/lines/:lineId/scheme-receipt': (request) => {
          record(request);
          return json(DETAIL);
        },
        'DELETE /brand-statements/bs-1/lines/:lineId/match': (request) => {
          record(request);
          return sent.filter((one) => one.method === 'DELETE').length === 1
            ? json({ statusCode: 409, message: 'This statement is discarded' }, 409)
            : json(DETAIL);
        },
      },
    });
    const brand = await screen.findByRole('table', { name: 'The brand’s statement' });
    const missing = found(
      within(brand)
        .getByText(/Row 6$/)
        .closest('tr'),
    );

    await user.click(within(missing).getByRole('button', { name: 'Match' }));
    let dialog = await screen.findByRole('dialog', { name: 'Match row 6 with a record of ours' });
    await user.click(within(dialog).getByRole('button', { name: 'Match' }));
    expect(await within(dialog).findAllByText('Choose a GRN or scheme money')).toHaveLength(2);
    await user.selectOptions(within(dialog).getByLabelText('Record'), 'grn:g3');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Billed under AD/150');
    await user.click(within(dialog).getByRole('button', { name: 'Match' }));
    expect(await screen.findByText('Saved')).toBeVisible();
    expect(sent.at(-1)).toEqual({
      method: 'POST',
      path: '/brand-statements/bs-1/lines/l-missing/match',
      body: { recordKey: 'grn:g3', note: 'Billed under AD/150' },
    });

    await user.click(within(missing).getByRole('button', { name: 'Explain' }));
    dialog = await screen.findByRole('dialog', { name: 'Explain row 6' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark explained' }));
    expect(await within(dialog).findByText('Write why')).toBeVisible();
    await user.type(within(dialog).getByLabelText('Why it is not in our books'), 'Freight');
    await user.click(within(dialog).getByRole('button', { name: 'Mark explained' }));
    await waitFor(() => {
      expect(sent.at(-1)?.body).toEqual({ note: 'Freight' });
    });

    const credit = found(within(brand).getByText('CN/7790').closest('tr'));
    expect(
      within(missing).queryByRole('button', { name: 'Record as scheme credit note' }),
    ).toBeNull();
    await user.click(within(credit).getByRole('button', { name: 'Record as scheme credit note' }));
    dialog = await screen.findByRole('dialog', { name: 'Record row 7 as a scheme credit note' });
    const scheme = await within(dialog).findByLabelText('Scheme');
    expect(within(scheme).queryByText('Old draft')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Record and match' }));
    expect(await within(dialog).findAllByText('Choose a running or closed scheme')).toHaveLength(2);
    await user.selectOptions(scheme, 'scheme-1');
    await user.type(within(dialog).getByLabelText('Note (optional)'), 'Part 2');
    await user.click(within(dialog).getByRole('button', { name: 'Record and match' }));
    await waitFor(() => {
      expect(sent.at(-1)).toMatchObject({
        path: '/brand-statements/bs-1/lines/l-cn/scheme-receipt',
        body: { schemeId: 'scheme-1', claimId: null, note: 'Part 2' },
      });
    });

    const auto = found(
      within(brand)
        .getByText(/Row 4$/)
        .closest('tr'),
    );
    await user.click(within(auto).getByRole('button', { name: 'Unmatch' }));
    expect(await screen.findByText('This statement is discarded')).toBeVisible();
    await user.click(within(auto).getByRole('button', { name: 'Unmatch' }));
    await waitFor(() => {
      expect(sent.filter((one) => one.method === 'DELETE')).toHaveLength(2);
    });
  });

  it('says when nothing is left to match or no scheme can take the credit note', async () => {
    const settled: BrandStatementDetail = {
      ...DETAIL,
      ours: DETAIL.ours.map((record) => ({ ...record, lineId: record.lineId ?? 'l-auto' })),
    };
    const { user } = renderApp({
      path: '/brand-statements/bs-1',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/:id': () => json(settled),
        'GET /brand-schemes': () => json([schemes[1]]),
      },
    });
    const brand = await screen.findByRole('table', { name: 'The brand’s statement' });
    await user.click(
      within(
        found(
          within(brand)
            .getByText(/Row 6$/)
            .closest('tr'),
        ),
      ).getByRole('button', {
        name: 'Match',
      }),
    );
    let dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Every record of ours is already matched.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(
      within(found(within(brand).getByText('CN/7790').closest('tr'))).getByRole('button', {
        name: 'Record as scheme credit note',
      }),
    );
    dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('The brand has no running or closed scheme.'),
    ).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(
      within(
        found(
          within(brand)
            .getByText(/Row 6$/)
            .closest('tr'),
        ),
      ).getByRole('button', {
        name: 'Explain',
      }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
  });

  it('matches again, downloads the mismatches and the file, and discards the statement', async () => {
    const saved: string[] = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:file'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    let csvAsked = 0;
    let discarded = false;
    const { user } = renderApp({
      path: '/brand-statements/bs-1',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/:id': () =>
          json(discarded ? { ...DETAIL, statement: { ...SUMMARY, status: 'discarded' } } : DETAIL),
        'POST /brand-statements/bs-1/match': () => json({ added: 1, removed: 2, detail: DETAIL }),
        'GET /brand-statements/bs-1/mismatches.csv': () => {
          csvAsked += 1;
          return csvAsked === 1
            ? {
                status: 200,
                raw: 'Side\r\n',
                headers: {
                  'content-disposition': 'attachment; filename="BS-000001-mismatches.csv"',
                },
              }
            : json({ statusCode: 500, message: 'Down' }, 500);
        },
        'GET /brand-statements/bs-1/file': () => ({ status: 200, raw: 'Date\r\n' }),
        'POST /brand-statements/bs-1/discard': () => {
          discarded = true;
          return json({ ...SUMMARY, status: 'discarded' });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Match again' }));
    expect(await screen.findByText('Matched again: 1 new, 2 removed')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Download mismatches (CSV)' }));
    await waitFor(() => {
      expect(saved).toEqual(['BS-000001-mismatches.csv']);
    });
    await user.click(screen.getByRole('button', { name: 'Download mismatches (CSV)' }));
    expect(await screen.findByText('Could not download the file')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Original file' }));
    await waitFor(() => {
      expect(saved).toEqual(['BS-000001-mismatches.csv', 'July.csv']);
    });
    await user.click(screen.getByRole('button', { name: 'Discard statement' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard this statement?' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard statement' }));
    expect(await screen.findByText('Statement discarded')).toBeVisible();
    expect(await screen.findByText('This statement was discarded.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Match again' })).toBeNull();
  });

  it('shows members who only see purchasing no changes, and a statement without its file', async () => {
    renderApp({
      path: '/brand-statements/bs-1',
      routes: {
        'GET /auth/me': () => json(BUYER),
        'GET /brand-statements/:id': () =>
          json({
            ...DETAIL,
            statement: { ...SUMMARY, fileKept: false, brand: null },
            summary: {
              ...DETAIL.summary,
              openingBalancePaise: null,
              brandClosingPaise: null,
              printedClosingPaise: null,
              counts: { ...DETAIL.summary.counts, untracked: 0 },
            },
            lines: [],
            ours: [],
          }),
      },
    });
    expect(await screen.findByText(/The original file was not kept/)).toBeVisible();
    expect(screen.getByText('No line to show.')).toBeVisible();
    expect(screen.getByText('No GRN or scheme money of ours in the period.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Match again' })).toBeNull();
    expect(screen.queryByText('Opening balance')).toBeNull();
  });

  it('says when the statement cannot be loaded', async () => {
    renderApp({
      path: '/brand-statements/bs-1',
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /brand-statements/:id': () => json({ statusCode: 500, message: 'Down' }, 500),
      },
    });
    expect(await screen.findByText('Could not load the statement')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Brand statements' })).toBeVisible();
  });
});
