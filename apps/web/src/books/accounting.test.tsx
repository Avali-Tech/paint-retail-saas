import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { todayInIndia } from '../lib/india-time.js';
import { OWNER, json, type FakeHandler, type FakeRequest } from '../test-support/fake-api.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import {
  BANK_MAPPING,
  EXPORT_ROW,
  KKP,
  MODES,
  PARTY_MAPPING,
  PREVIEW,
  ROUND_OFF_MAPPING,
  SALES_MAPPING,
  STORES,
} from './test-support/books-fixtures.js';

const click = vi.fn<(this: HTMLAnchorElement) => void>();
const location = () => screen.getByTestId('location').textContent;
const previews = (requests: FakeRequest[]) =>
  requests.filter((request) => request.path === '/accounting-exports/preview');

beforeEach(() => {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:export'), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
    this: HTMLAnchorElement,
  ) {
    click.call(this);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  click.mockClear();
});

const exportRoutes = (
  overrides: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /accounting-exports/preview': () => json(PREVIEW()),
  'GET /accounting-exports': () =>
    json({ items: [EXPORT_ROW(), EXPORT_ROW({ id: 'export-2', documentId: null })], total: 2 }),
  ...overrides,
});

describe('AccountingExportPage', { timeout: 30_000 }, () => {
  it('previews the month, exports the file and lists past exports', async () => {
    let exported = 0;
    const today = todayInIndia();
    const { user, requests } = renderApp({
      path: '/accounting',
      routes: exportRoutes({
        'POST /accounting-exports': () => {
          exported += 1;
          return {
            status: 200,
            raw: 'PK',
            headers: { 'content-disposition': 'attachment; filename="tally-export.xlsx"' },
          };
        },
        'GET /documents/:id/download': () => ({
          status: 200,
          raw: 'PK',
          headers: { 'content-disposition': 'attachment; filename="tally-september.zip"' },
        }),
      }),
    });
    await waitFor(() => {
      expect(location()).toBe('/accounting/export');
    });
    expect(await screen.findByRole('heading', { name: 'Tally export', level: 1 })).toBeVisible();
    const counts = await screen.findByLabelText('Vouchers in the period');
    expect(counts).toHaveTextContent('Sales40Credit notes3Debit notes1Receipts15');
    expect(previews(requests).at(-1)?.query.toString()).toBe(
      `from=${today.slice(0, 8)}01&to=${today}&kinds=sales%2Ccredit_note%2Cdebit_note%2Creceipt`,
    );
    expect(screen.getByRole('textbox', { name: /Company name in Tally/ })).toHaveAttribute(
      'placeholder',
      'ABC Paints Private Limited',
    );

    const history = await screen.findByRole('table', { name: 'Past exports' });
    const [, kept, lost] = within(history).getAllByRole('row');
    expect(kept).toHaveTextContent(
      '1 Sept 2026 to 30 Sept 2026Tally XML (zip)Sales, Receipts55Anil Kumar',
    );
    expect(lost).toHaveTextContent('Not kept');
    await user.click(within(found(kept)).getByRole('button', { name: 'Download' }));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(click.mock.contexts[0]?.download).toBe('tally-september.zip');

    await user.click(screen.getByRole('checkbox', { name: 'Debit notes' }));
    await waitFor(() => {
      expect(previews(requests).at(-1)?.query.get('kinds')).toBe('sales,credit_note,receipt');
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'File' }), 'xlsx');
    await user.type(screen.getByRole('textbox', { name: /Company name in Tally/ }), ' ABC ');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('Export saved to your downloads')).toBeVisible();
    expect(click.mock.contexts[1]?.download).toBe('tally-export.xlsx');
    expect(exported).toBe(1);
    expect(requests.find((request) => request.method === 'POST')?.body).toEqual({
      from: `${today.slice(0, 8)}01`,
      to: today,
      kinds: ['sales', 'credit_note', 'receipt'],
      format: 'xlsx',
      companyName: 'ABC',
    });
    await waitFor(() => {
      expect(requests.filter((request) => request.path === '/accounting-exports')).toHaveLength(3);
    });
  });

  it('lists what stops an export and what is left to enter by hand', async () => {
    const { user } = renderApp({
      path: '/accounting/export',
      routes: exportRoutes({
        'GET /accounting-exports/preview': () =>
          json(
            PREVIEW({
              problems: [
                {
                  code: 'unmapped_ledger',
                  document: 'RC-000001',
                  message: 'No ledger for payment mode "Bank transfer" (bank_transfer)',
                },
              ],
              manual: { refunds: 1, bouncedCheques: 2 },
            }),
          ),
      }),
    });
    expect(
      await screen.findByText('No ledger for payment mode "Bank transfer" (bank_transfer)'),
    ).toBeVisible();
    expect(
      screen.getByText(
        '1 refund and 2 bounced cheques in this period are not in the export: enter them in Tally by hand.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    await user.click(screen.getByRole('link', { name: 'Map ledgers' }));
    await waitFor(() => {
      expect(location()).toBe('/accounting/ledgers');
    });
  });

  it('checks the period and the kinds before asking', async () => {
    const { user, requests } = renderApp({
      path: '/accounting/export',
      routes: exportRoutes({
        'GET /accounting-exports/preview': () =>
          json(PREVIEW({ counts: { sales: 0, credit_note: 0, debit_note: 0, receipt: 0 } })),
      }),
    });
    expect(await screen.findByText('Nothing to export in this period.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    const asked = previews(requests).length;

    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    await user.clear(from);
    await user.type(from, '2026-12-01');
    await user.clear(to);
    await user.type(to, '2026-11-01');
    expect(await screen.findByText('The period ends before it starts')).toBeVisible();
    await user.clear(to);
    await user.clear(from);
    for (const kind of ['Sales', 'Credit notes', 'Debit notes', 'Receipts']) {
      await user.click(screen.getByRole('checkbox', { name: kind }));
    }
    expect(screen.getByText('Choose at least one kind of voucher')).toBeVisible();
    await user.type(from, '2026-10-01');
    expect(previews(requests)).toHaveLength(asked);
  });

  it('shows failures: the preview, the export, the history and its downloads', async () => {
    let previewDown = false;
    const { user } = renderApp({
      path: '/accounting/export',
      routes: exportRoutes({
        'GET /accounting-exports/preview': () =>
          previewDown ? json({ message: 'Down' }, 500) : json(PREVIEW()),
        'POST /accounting-exports': () => ({ status: 200, raw: 'PK' }),
        'GET /documents/:id/download': () =>
          json({ statusCode: 503, message: 'Document storage is not set up on this server' }, 503),
      }),
    });
    await screen.findByLabelText('Vouchers in the period');
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('Export saved to your downloads')).toBeVisible();
    expect(String(click.mock.contexts[0]?.download)).toMatch(/^tally-\d{4}-\d{2}-01-to-/);

    await user.click(found(screen.getAllByRole('button', { name: 'Download' })[0]));
    expect(await screen.findByText('Document storage is not set up on this server')).toBeVisible();

    previewDown = true;
    await user.click(screen.getByRole('checkbox', { name: 'Receipts' }));
    expect(await screen.findByText('Could not check the period')).toBeVisible();
  });

  it('shows why an export failed, a history without a file name, and an empty history', async () => {
    const first = renderApp({
      path: '/accounting/export',
      routes: exportRoutes({
        'POST /accounting-exports': () =>
          json({ statusCode: 422, message: 'Cannot export to Tally', issues: [] }, 422),
        'GET /documents/:id/download': () => ({ status: 200, raw: 'PK' }),
      }),
    });
    await screen.findByLabelText('Vouchers in the period');
    await first.user.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('Cannot export to Tally')).toBeVisible();
    await first.user.click(found(screen.getAllByRole('button', { name: 'Download' })[0]));
    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce();
    });
    expect(click.mock.contexts[0]?.download).toBe('tally-2026-09-01-to-2026-09-30');
    first.unmount();

    renderApp({
      path: '/accounting/export',
      routes: exportRoutes({ 'GET /accounting-exports': () => json({ items: [], total: 0 }) }),
    });
    expect(await screen.findByText('Nothing exported yet.')).toBeVisible();
  });

  it('shows a history that did not load', async () => {
    renderApp({
      path: '/accounting/export',
      routes: exportRoutes({ 'GET /accounting-exports': () => json({ message: 'Down' }, 500) }),
    });
    expect(await screen.findByText('Could not load the past exports')).toBeVisible();
  });
});

const mappingRoutes = (
  overrides: Record<string, FakeHandler> = {},
): Record<string, FakeHandler> => ({
  'GET /auth/me': () => json(OWNER),
  'GET /stores': () => json(STORES),
  'GET /payment-modes': () => json(MODES),
  'GET /ledger-mappings': () =>
    json([SALES_MAPPING, BANK_MAPPING, PARTY_MAPPING, ROUND_OFF_MAPPING]),
  ...overrides,
});

describe('LedgerMappingsPage', { timeout: 30_000 }, () => {
  it('lists mappings with what they match, and adds one for a rate and store', async () => {
    const { user, requests } = renderApp({
      path: '/accounting/ledgers',
      routes: mappingRoutes({
        'POST /ledger-mappings': (request) =>
          (request.body as { ledgerName: string }).ledgerName === 'Taken'
            ? json({ statusCode: 422, message: 'Cannot save the ledger mapping', issues: [] }, 422)
            : json(SALES_MAPPING, 201),
      }),
    });
    const table = await screen.findByRole('table', { name: 'Ledger mapping' });
    const [, sales, bank, party, round] = within(table).getAllByRole('row');
    expect(sales).toHaveTextContent(
      'Sales18% · Taxable · Within the state · AMP · AmeerpetSales 18% AmeerpetUsual group',
    );
    expect(bank).toHaveTextContent(
      'Payment modeBank transfer · Bank transferHDFC BankBank Accounts',
    );
    expect(party).toHaveTextContent('A customerDeccan ContractorsDeccan Contractors (Hyd)');
    expect(round).toHaveTextContent('Round-offAnyRounding');
    expect(screen.getByRole('link', { name: 'Ledger mapping' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    const form = screen.getByRole('form', { name: 'Add a mapping' });
    const field = (name: string | RegExp) => within(form).getByRole('textbox', { name });
    await user.type(field(/GST rate/), 'x');
    await user.clear(field(/^Order/));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(form).findByText('Enter a rate from 0 to 100, such as 18 or 2.5'),
    ).toBeVisible();
    expect(within(form).getByText('This is required')).toBeVisible();
    expect(within(form).getByText('Enter a whole number from 0 to 10000')).toBeVisible();

    await user.clear(field(/GST rate/));
    await user.type(field(/GST rate/), '18');
    await user.type(field(/^Order/), '1');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'GST nature' }), 'taxable');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Supply' }), 'inter_state');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Store' }), KKP.id);
    await user.selectOptions(
      within(form).getByRole('combobox', { name: /^Group/ }),
      'Sales Accounts',
    );
    await user.type(field('Tally ledger'), 'Taken');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Cannot save the ledger mapping')).toBeVisible();
    await user.clear(field('Tally ledger'));
    await user.type(field('Tally ledger'), 'Sales 18% Interstate');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Mapping saved')).toBeVisible();
    expect(requests.filter((request) => request.method === 'POST').at(-1)?.body).toEqual({
      purpose: 'sales',
      rateBasisPoints: 1800,
      nature: 'taxable',
      supplyType: 'inter_state',
      storeId: KKP.id,
      ledgerName: 'Sales 18% Interstate',
      group: 'Sales Accounts',
      position: 1,
    });
    // A fresh form for the next one.
    expect(
      within(screen.getByRole('form', { name: 'Add a mapping' })).getByRole('textbox', {
        name: 'Tally ledger',
      }),
    ).toHaveValue('');
  });

  it('maps a payment mode and a customer', async () => {
    const { user, requests } = renderApp({
      path: '/accounting/ledgers',
      routes: mappingRoutes({
        'POST /ledger-mappings': () => json(BANK_MAPPING, 201),
        'GET /parties': () => json({ items: [PARTY], total: 1 }),
      }),
    });
    let form = await screen.findByRole('form', { name: 'Add a mapping' });
    await user.selectOptions(within(form).getByRole('combobox', { name: 'For' }), 'payment_mode');
    expect(within(form).queryByRole('textbox', { name: /GST rate/ })).toBeNull();
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Kind of payment' }),
      'bank_transfer',
    );
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Payment mode' }),
      'mode-bank',
    );
    await user.type(within(form).getByRole('textbox', { name: 'Tally ledger' }), 'HDFC Bank');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText('Mapping saved');
    expect(requests.filter((request) => request.method === 'POST').at(-1)?.body).toEqual({
      purpose: 'payment_mode',
      modeKind: 'bank_transfer',
      modeId: 'mode-bank',
      ledgerName: 'HDFC Bank',
      position: 0,
    });

    form = screen.getByRole('form', { name: 'Add a mapping' });
    await user.selectOptions(within(form).getByRole('combobox', { name: 'For' }), 'party');
    await user.type(within(form).getByRole('textbox', { name: 'Tally ledger' }), 'Apex (Hyd)');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Choose the customer')).toBeVisible();
    await user.type(within(form).getByRole('searchbox'), 'Apex');
    await user.click(await within(form).findByRole('button', { name: 'Choose Apex Builders' }));
    expect(within(form).getByText('Customer: Apex Builders')).toBeVisible();
    // The picker went with the chosen button: the focus moves to "Change customer".
    await waitFor(() => {
      expect(within(form).getByRole('button', { name: 'Change customer' })).toHaveFocus();
    });
    await user.click(within(form).getByRole('button', { name: 'Change customer' }));
    await user.type(within(form).getByRole('searchbox'), 'Apex');
    await user.click(await within(form).findByRole('button', { name: 'Choose Apex Builders' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2);
    });
    expect(requests.filter((request) => request.method === 'POST').at(-1)?.body).toEqual({
      purpose: 'party',
      partyId: PARTY.id,
      ledgerName: 'Apex (Hyd)',
      position: 0,
    });
  });

  it('changes and removes mappings', async () => {
    let removeFails = true;
    const { user, requests } = renderApp({
      path: '/accounting/ledgers',
      routes: mappingRoutes({
        'PUT /ledger-mappings/:id': () => json(BANK_MAPPING),
        'DELETE /ledger-mappings/:id': () => {
          if (removeFails) {
            removeFails = false;
            return json({ statusCode: 404, message: 'Ledger mapping not found' }, 404);
          }
          return { status: 204 };
        },
      }),
    });
    await screen.findByRole('table', { name: 'Ledger mapping' });
    await user.click(screen.getByRole('button', { name: 'Change HDFC Bank' }));
    let form = screen.getByRole('form', { name: 'Change the mapping' });
    expect(within(form).getByRole('textbox', { name: 'Tally ledger' })).toHaveValue('HDFC Bank');
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('form', { name: 'Add a mapping' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Change HDFC Bank' }));
    form = screen.getByRole('form', { name: 'Change the mapping' });
    const name = within(form).getByRole('textbox', { name: 'Tally ledger' });
    await user.clear(name);
    await user.type(name, 'ICICI Bank');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText('Mapping saved');
    // A fresh editor replaces the one saved: the focus goes to the heading, not the page.
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    });
    const put = requests.find((request) => request.method === 'PUT');
    expect(put?.path).toBe(`/ledger-mappings/${BANK_MAPPING.id}`);
    expect(put?.body).toEqual({
      purpose: 'payment_mode',
      modeKind: 'bank_transfer',
      modeId: 'mode-bank',
      ledgerName: 'ICICI Bank',
      group: 'Bank Accounts',
      position: 0,
    });

    await user.click(screen.getByRole('button', { name: 'Remove Rounding' }));
    expect(await screen.findByText('Ledger mapping not found')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove Rounding' }));
    expect(
      await screen.findByText('Mapping removed: the usual ledger applies again'),
    ).toBeVisible();
    expect(requests.filter((request) => request.method === 'DELETE').at(-1)?.path).toBe(
      `/ledger-mappings/${ROUND_OFF_MAPPING.id}`,
    );
  });

  it('says when nothing is mapped, or the mappings do not load', async () => {
    const first = renderApp({
      path: '/accounting/ledgers',
      routes: mappingRoutes({ 'GET /ledger-mappings': () => json([]) }),
    });
    expect(
      await screen.findByText('No mappings yet: every amount uses its usual ledger.'),
    ).toBeVisible();
    first.unmount();
    renderApp({
      path: '/accounting/ledgers',
      routes: mappingRoutes({ 'GET /ledger-mappings': () => json({ message: 'Down' }, 500) }),
    });
    expect(await screen.findByText('Could not load the ledger mappings')).toBeVisible();
  });
});
