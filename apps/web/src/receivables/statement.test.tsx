import { buildStatementView, emptyTotals, type StatementData } from '@paint/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatementA4 } from '../print/StatementA4.js';
import { OWNER, json, profile } from '../test-support/fake-api.js';
import { PARTY } from '../test-support/party-fixtures.js';
import { found } from '../test-support/found.js';
import { renderApp } from '../test-support/render-app.js';
import { financialYearStart, statementChoice } from './statement-logic.js';

const location = () => screen.getByTestId('location').textContent;

const DATA: StatementData = {
  business: {
    name: 'ABC Paints',
    legalName: 'ABC Paints Private Limited',
    gstin: '36AABCS1429B1Z5',
    address: '1-2-3 Main Road, Hyderabad',
  },
  party: {
    id: PARTY.id,
    name: 'Apex Builders',
    phone: '9876543210',
    gstin: '36AABCU9603R1ZO',
    address: 'Plot 12, Madhapur, Hyderabad',
  },
  from: '2026-04-01',
  to: '2026-10-11',
  generatedOn: '2026-10-11',
  openingPaise: 0,
  entries: [
    {
      entryOn: '2026-09-05',
      entryType: 'invoice',
      referenceNumber: 'AMP/26-27/000007',
      note: 'AMP/26-27/000007',
      amountPaise: 1_180_00,
      balancePaise: 1_180_00,
    },
    {
      entryOn: '2026-09-20',
      entryType: 'payment_in',
      referenceNumber: 'RC-000003',
      note: 'UPI from site',
      amountPaise: -500_00,
      balancePaise: 680_00,
    },
  ],
  debitsPaise: 1_180_00,
  creditsPaise: 500_00,
  closingPaise: 680_00,
  ageing: {
    buckets: { ...emptyTotals().buckets, days_31_60: 680_00 },
    outstandingPaise: 680_00,
    unappliedPaise: 0,
    netPaise: 680_00,
  },
  openItems: [
    {
      kind: 'invoice',
      number: 'AMP/26-27/000007',
      raisedOn: '2026-09-05',
      dueOn: '2026-09-05',
      outstandingPaise: 680_00,
      daysPastDue: 36,
    },
  ],
};

const routes = (data: StatementData = DATA, extra = {}) => ({
  'GET /auth/me': () => json(OWNER),
  'GET /parties/:id/statement': () => json(data),
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('statement period and language', () => {
  it('starts on 1 April of the financial year', () => {
    expect(financialYearStart('2026-10-11')).toBe('2026-04-01');
    expect(financialYearStart('2026-04-01')).toBe('2026-04-01');
    expect(financialYearStart('2027-03-31')).toBe('2026-04-01');
  });

  it('takes the address’s period and language, else this year to today in the member’s language', () => {
    expect(statementChoice({ from: '', to: '', lang: '' }, '2026-10-11', 'te')).toEqual({
      from: '2026-04-01',
      to: '2026-10-11',
      lang: 'te',
      backwards: false,
    });
    expect(
      statementChoice({ from: '2026-09-01', to: '2026-09-30', lang: 'hi' }, '2026-10-11', 'en'),
    ).toEqual({ from: '2026-09-01', to: '2026-09-30', lang: 'hi', backwards: false });
    expect(
      statementChoice({ from: '2026-10-05', to: '2026-10-01', lang: 'fr' }, '2026-10-11', 'en'),
    ).toEqual({ from: '2026-10-05', to: '2026-10-01', lang: 'en', backwards: true });
    expect(
      statementChoice({ from: 'x', to: '2026-02-01', lang: '' }, '2026-10-11', 'en').from,
    ).toBe('2025-04-01');
  });
});

describe('StatementPage', { timeout: 30_000 }, () => {
  it('shows this year’s statement on A4 in the member’s language, with the ledger a click away', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-11T06:30:00Z') });
    const { requests } = renderApp({ path: `/parties/${PARTY.id}/statement`, routes: routes() });
    expect(
      await screen.findByRole('heading', { name: 'Statement · Apex Builders', level: 1 }),
    ).toBeVisible();
    const request = requests.find((r) => r.path === `/parties/${PARTY.id}/statement`);
    expect(request?.query.toString()).toBe('from=2026-04-01&to=2026-10-11');
    expect(screen.getByRole('link', { name: 'Ledger' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}/ledger`,
    );
    expect(screen.getByRole('link', { name: 'Back to Apex Builders' })).toHaveAttribute(
      'href',
      `/parties/${PARTY.id}`,
    );
    const paper = screen.getByRole('article', { name: 'Statement of Account · Apex Builders' });
    expect(paper).toHaveTextContent(
      'ABC PaintsABC Paints Private Limited1-2-3 Main Road, Hyderabad',
    );
    expect(paper).toHaveTextContent('GSTIN: 36AABCS1429B1Z5');
    expect(paper).toHaveTextContent('Period01 Apr 2026 – 11 Oct 2026');
    expect(paper).toHaveTextContent('Opening balance0.00Closing balance680.00 Dr');
    const [entries, open] = within(paper).getAllByRole('table');
    expect(within(found(entries)).getAllByRole('row')[2]).toHaveTextContent(
      '05 Sep 2026InvoiceAMP/26-27/0000071,180.001,180.00 Dr',
    );
    expect(entries).toHaveTextContent('Payment receivedUPI from siteRC-000003500.00680.00 Dr');
    expect(entries).toHaveTextContent('Total1,180.00500.00680.00 Dr');
    expect(paper).toHaveTextContent('Ageing · 11 Oct 2026');
    expect(paper).toHaveTextContent('31–60 days680.00');
    expect(open).toHaveTextContent('AMP/26-27/00000705 Sep 202605 Sep 202636680.00');
    expect(paper).toHaveTextContent('This is a computer-generated statement.');
    expect(screen.getByLabelText('Labels on the statement')).toHaveValue('en');
  });

  it('changes the period and the second language, and refuses a backwards period', async () => {
    const { user, requests } = renderApp({
      path: `/parties/${PARTY.id}/statement?from=2026-09-01&to=2026-09-30`,
      routes: routes(),
    });
    await screen.findByRole('article');
    await user.selectOptions(screen.getByLabelText('Labels on the statement'), 'te');
    expect(location()).toContain('lang=te');
    expect(screen.getByRole('article')).toHaveTextContent('Statement of Account ఖాతా వివరణ');
    // A date picker sets the whole date at once.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-05' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-01' } });
    expect(await screen.findByText('The end date cannot be before the start date')).toBeVisible();
    expect(screen.queryByRole('article')).toBeNull();
    expect(
      requests.every((r) => !r.query.toString().includes('from=2026-10-05&to=2026-10-01')),
    ).toBe(true);
  });

  it('shares on WhatsApp in one click: the link carries the message and the PDF is saved', async () => {
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:statement'),
      revokeObjectURL: vi.fn(),
    });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    const { user, requests } = renderApp({
      path: `/parties/${PARTY.id}/statement?from=2026-04-01&to=2026-10-11&lang=hi`,
      routes: routes(DATA, {
        'GET /parties/:id/statement.pdf': () => ({
          status: 200,
          raw: '%PDF-1.7',
          headers: { 'content-disposition': 'attachment; filename="Statement-Apex.pdf"' },
        }),
      }),
    });
    const share = await screen.findByRole('link', { name: 'Share on WhatsApp' });
    const href = String(share.getAttribute('href'));
    expect(href.startsWith('https://wa.me/919876543210?text=')).toBe(true);
    expect(decodeURIComponent(href.split('text=')[1] ?? '')).toContain(
      'नमस्ते Apex Builders, ABC Paints से 01 Apr 2026 से 11 Oct 2026 तक का आपका खाता विवरण',
    );
    expect(share).toHaveAttribute('target', '_blank');
    // The link would open WhatsApp in a new tab; the test stays on the page.
    share.addEventListener('click', (event) => {
      event.preventDefault();
    });
    await user.click(share);
    await waitFor(() => {
      expect(names).toEqual(['Statement-Apex.pdf']);
    });
    expect(await screen.findByText('PDF saved: attach it in WhatsApp')).toBeVisible();
    const pdf = requests.find((r) => r.path === `/parties/${PARTY.id}/statement.pdf`);
    expect(pdf?.query.toString()).toBe('from=2026-04-01&to=2026-10-11&lang=hi');
    expect(screen.queryByText(/No mobile number/)).toBeNull();
  });

  it('downloads and prints, names the file when the server does not, and says when it cannot', async () => {
    Object.assign(URL, {
      createObjectURL: vi.fn(() => 'blob:statement'),
      revokeObjectURL: vi.fn(),
    });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function record(
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    let answer = 0;
    const { user } = renderApp({
      path: `/parties/${PARTY.id}/statement?from=2026-04-01&to=2026-10-11`,
      routes: routes(
        { ...DATA, party: { ...DATA.party, phone: null } },
        {
          'GET /parties/:id/statement.pdf': () => {
            answer += 1;
            return answer === 1
              ? { status: 200, raw: '%PDF-1.7' }
              : json({ statusCode: 404, message: 'Customer not found' }, 404);
          },
        },
      ),
    });
    expect(
      await screen.findByText('No mobile number on record: WhatsApp will ask whom to send it to.'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Share on WhatsApp' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^https:\/\/wa\.me\/\?text=/),
    );
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => {
      expect(names).toEqual(['Statement-Apex-Builders-2026-04-01-2026-10-11.pdf']);
    });
    expect(screen.queryByText('PDF saved: attach it in WhatsApp')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(await screen.findByText('Customer not found')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('says when the statement cannot be loaded, and is behind sales:read', async () => {
    renderApp({
      path: `/parties/${PARTY.id}/statement`,
      routes: {
        'GET /auth/me': () => json(OWNER),
        'GET /parties/:id/statement': () => json({ statusCode: 404, message: 'Not found' }, 404),
      },
    });
    expect(await screen.findByText('Could not load the statement')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Statement', level: 1 })).toBeVisible();
    expect(screen.queryByRole('link', { name: /Back to/ })).toBeNull();
  });

  it('refuses members who cannot see ledgers', async () => {
    renderApp({
      path: `/parties/${PARTY.id}/statement`,
      routes: { 'GET /auth/me': () => json(profile(['parties:read'])) },
    });
    expect(await screen.findByText('No access')).toBeVisible();
  });
});

describe('StatementA4', () => {
  it('leaves out what is not known and says when a period has no entries', () => {
    render(
      <StatementA4
        view={buildStatementView(
          {
            ...DATA,
            business: { name: 'ABC Paints', legalName: null, gstin: null, address: null },
            party: { ...DATA.party, phone: null, gstin: null, address: null },
            entries: [],
            openItems: [],
            ageing: { ...emptyTotals(), unappliedPaise: 100, netPaise: -100 },
          },
          'hi',
        )}
      />,
    );
    const paper = screen.getByRole('article');
    expect(paper).toHaveTextContent('No entries in this period');
    expect(paper).not.toHaveTextContent('GSTIN');
    expect(paper).not.toHaveTextContent('Bills due');
    expect(paper).toHaveTextContent('Paid in advance');
    expect(within(paper).queryAllByRole('table')).toEqual([]);
  });

  it('prints an opening balance, which has no document number', () => {
    render(
      <StatementA4
        view={buildStatementView(
          {
            ...DATA,
            entries: [
              {
                entryOn: '2026-04-01',
                entryType: 'opening',
                referenceNumber: null,
                note: 'Opening balance at go-live',
                amountPaise: 200_00,
                balancePaise: 200_00,
              },
            ],
          },
          null,
        )}
      />,
    );
    const [entries] = within(screen.getByRole('article')).getAllByRole('table');
    expect(within(found(entries)).getAllByRole('row')[2]).toHaveTextContent(
      '01 Apr 2026Opening balanceOpening balance at go-live200.00200.00 Dr',
    );
  });
});
