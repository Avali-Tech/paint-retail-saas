import type { PartyLedgerEntryView, PartyLedgerView } from '@paint/shared';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { renderApp } from '../test-support/render-app.js';
import { LEDGER_PAGE_SIZE, referencePath } from './PartyLedgerPage.js';

const location = () => screen.getByTestId('location').textContent;

const entry = (overrides: Partial<PartyLedgerEntryView>): PartyLedgerEntryView => ({
  id: 'e-1',
  entryOn: '2026-10-01',
  entryType: 'invoice',
  amountPaise: 11_800_00,
  referenceType: 'tax_document',
  referenceId: 'inv-1',
  referenceNumber: 'AMP/26-27/000001',
  note: 'AMP/26-27/000001',
  balancePaise: 11_800_00,
  ...overrides,
});

const ENTRIES: PartyLedgerEntryView[] = [
  entry({
    id: 'e-0',
    entryType: 'opening',
    amountPaise: 2_000_00,
    referenceType: 'go_live',
    referenceId: PARTY.id,
    referenceNumber: null,
    note: 'Opening balance at go-live',
    balancePaise: 2_000_00,
  }),
  entry({ balancePaise: 13_800_00 }),
  entry({
    id: 'e-2',
    entryOn: '2026-10-02',
    entryType: 'credit_note',
    amountPaise: -1_800_00,
    referenceId: 'cn-1',
    referenceNumber: 'AMPCN/26-27/0001',
    note: 'AMPCN/26-27/0001',
    balancePaise: 12_000_00,
  }),
  entry({
    id: 'e-3',
    entryOn: '2026-10-03',
    entryType: 'payment_in',
    amountPaise: -15_000_00,
    referenceType: 'payment',
    referenceId: 'pay-1',
    referenceNumber: 'RC-000012',
    note: 'RC-000012',
    balancePaise: -3_000_00,
  }),
  entry({
    id: 'e-4',
    entryOn: '2026-10-04',
    entryType: 'adjustment',
    amountPaise: 3_000_00,
    referenceType: 'payment',
    referenceId: 'pay-x',
    referenceNumber: null,
    note: null,
    balancePaise: 0,
  }),
];

const ledger = (overrides: Partial<PartyLedgerView> = {}): PartyLedgerView => ({
  partyId: PARTY.id,
  from: null,
  to: null,
  openingPaise: 0,
  entries: ENTRIES,
  closingPaise: 0,
  nextCursor: 'cursor-2',
  total: LEDGER_PAGE_SIZE + 5,
  totalCapped: false,
  balancePaise: -3_000_00,
  advancePaise: 3_000_00,
  openDocuments: [],
  ...overrides,
});

describe('referencePath', () => {
  it('opens invoices, notes and payments, and nothing else', () => {
    expect(referencePath(entry({}))).toBe('/invoices/inv-1');
    expect(referencePath(entry({ entryType: 'cancellation' }))).toBe('/invoices/inv-1');
    expect(referencePath(entry({ entryType: 'debit_note', referenceId: 'dn-1' }))).toBe(
      '/notes/dn-1',
    );
    expect(
      referencePath(
        entry({ referenceType: 'payment', referenceId: 'p', referenceNumber: 'RC 1/2' }),
      ),
    ).toBe('/payments/p');
    expect(referencePath(entry({ referenceType: 'go_live' }))).toBeNull();
    expect(referencePath(entry({ referenceType: null, referenceId: null }))).toBeNull();
  });
});

describe('PartyLedgerPage', { timeout: 30_000 }, () => {
  it("shows a party's account a page at a time, with links, balances and a date filter", async () => {
    const { user, requests } = renderApp({
      path: `/parties/${PARTY.id}/ledger`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties/:id': () => json(PARTY),
        'GET /parties/:id/ledger': (request) =>
          json(
            request.query.get('cursor') === 'cursor-2'
              ? ledger({
                  openingPaise: 0,
                  entries: [entry({ id: 'e-9', entryOn: '2026-10-09' })],
                  closingPaise: 11_800_00,
                  nextCursor: null,
                })
              : ledger(),
          ),
      },
    });
    expect(
      await screen.findByRole('heading', { name: 'Ledger · Apex Builders', level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    expect(screen.getByRole('link', { name: 'Take a payment' })).toHaveAttribute(
      'href',
      `/payments/new?partyId=${PARTY.id}`,
    );
    const table = await screen.findByRole('table', { name: 'Ledger entries' });
    const ledgerRequest = requests.find((request) => request.path.endsWith('/ledger'));
    expect(ledgerRequest?.query.toString()).toBe('limit=50&offset=0');
    const [, opening, invoice, credit, payment, charge] = within(table).getAllByRole('row');
    expect(opening).toHaveTextContent('1 Oct 2026Opening balanceOpening balance at go-live');
    expect(opening).toHaveTextContent('₹2,000.00₹2,000.00 Dr');
    const link = (name: string) => within(table).getByRole('link', { name });
    // The invoice, the note, the payment and the bounce charge (to its cheque) link; the opening balance does not.
    expect(within(table).getAllByRole('link')).toHaveLength(4);
    expect(link('AMP/26-27/000001')).toHaveAttribute('href', '/invoices/inv-1');
    expect(invoice).toHaveTextContent('AMP/26-27/000001Invoice₹11,800.00₹13,800.00 Dr');
    expect(link('AMPCN/26-27/0001')).toHaveAttribute('href', '/notes/cn-1');
    expect(credit).toHaveTextContent('AMPCN/26-27/0001Credit note₹1,800.00₹12,000.00 Dr');
    expect(link('RC-000012')).toHaveAttribute('href', '/payments/pay-1');
    expect(payment).toHaveTextContent('RC-000012Payment₹15,000.00₹3,000.00 Cr');
    expect(charge).toHaveTextContent('4 Oct 2026Adjustment₹3,000.00₹0.00');
    expect(link('Adjustment')).toHaveAttribute('href', '/payments/pay-x');
    const facts = screen.getByText('Opening balance', { selector: 'dt' }).closest('dl');
    expect(facts).toHaveTextContent(
      'Opening balance₹0.00Closing balance₹0.00Balance today₹3,000.00 CrAdvance₹3,000.00 Cr',
    );
    expect(screen.getByText('1–50 of 55')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await within(table).findByText('9 Oct 2026')).toBeVisible();
    expect(requests.at(-1)?.query.toString()).toBe('limit=50&offset=50&cursor=cursor-2');
    expect(screen.getByText('Closing balance').nextSibling).toHaveTextContent('₹11,800.00 Dr');

    await user.type(screen.getByLabelText('From'), '2026-10-01');
    await user.type(screen.getByLabelText('To'), '2026-10-31');
    await waitFor(() => {
      expect(requests.at(-1)?.query.toString()).toBe(
        'from=2026-10-01&to=2026-10-31&limit=50&offset=0',
      );
    });
    await user.click(await screen.findByRole('link', { name: 'AMP/26-27/000001' }));
    await waitFor(() => {
      expect(location()).toBe('/invoices/inv-1');
    });
  });

  it('says when a period has no entries, still with its balances', async () => {
    renderApp({
      path: `/parties/${PARTY.id}/ledger?from=2027-01-01`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties/:id': () => json(PARTY),
        'GET /parties/:id/ledger': () =>
          json(
            ledger({
              openingPaise: 5_000_00,
              closingPaise: 5_000_00,
              entries: [],
              nextCursor: null,
              total: 0,
              balancePaise: 5_000_00,
              advancePaise: 0,
            }),
          ),
      },
    });
    expect(await screen.findByText('No entries in this period')).toBeVisible();
    expect(screen.getByText('Opening balance', { selector: 'dt' }).closest('dl')).toHaveTextContent(
      'Opening balance₹5,000.00 DrClosing balance₹5,000.00 DrBalance today₹5,000.00 Dr',
    );
    expect(screen.queryByText('Advance')).toBeNull();
  });

  it('shows the ledger to a role that cannot open the customer record', async () => {
    renderApp({
      path: `/parties/${PARTY.id}/ledger`,
      routes: {
        'GET /auth/me': () => json(profile(['sales:read'])),
        'GET /parties/:id': () => json({ statusCode: 403, message: 'Forbidden' }, 403),
        'GET /parties/:id/ledger': () => json(ledger({ nextCursor: null, total: 5 })),
      },
    });
    expect(await screen.findByRole('table', { name: 'Ledger entries' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Ledger', level: 1 })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Take a payment' })).toBeNull();
  });

  it('is behind sales:read, as the ledger API is', async () => {
    renderApp({
      path: `/parties/${PARTY.id}/ledger`,
      routes: { 'GET /auth/me': () => json(profile(['parties:read'])) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});
