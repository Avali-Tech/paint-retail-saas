import { describe, expect, it } from 'vitest';
import { emptyTotals } from './ageing.js';
import type { StatementData } from './api.js';
import { STATEMENT_LABEL_KEYS, STATEMENT_LABELS, statementLabels } from './statement-labels.js';
import { buildStatementView, statementFileName, statementShareText } from './statement-view.js';

const DATA: StatementData = {
  business: {
    name: 'Rangoli Paints',
    legalName: 'Rangoli Paints Private Limited',
    gstin: '36AABCS1429B1Z5',
    address: '1-2-3 Main Road, Hyderabad 500016',
  },
  party: {
    id: 'party-1',
    name: 'Deccan Contractors',
    phone: '9876543210',
    gstin: null,
    address: 'Kukatpally, Hyderabad',
  },
  from: '2026-09-01',
  to: '2026-10-11',
  generatedOn: '2026-10-11',
  openingPaise: 50_000,
  entries: [
    {
      entryOn: '2026-09-05',
      entryType: 'invoice',
      referenceNumber: 'AMP/26-27/000007',
      note: 'AMP/26-27/000007',
      amountPaise: 118_000,
      balancePaise: 168_000,
    },
    {
      entryOn: '2026-09-20',
      entryType: 'payment_in',
      referenceNumber: 'RC-000003',
      note: 'UPI from site',
      amountPaise: -200_000,
      balancePaise: -32_000,
    },
    {
      entryOn: '2026-10-01',
      entryType: 'cheque_bounce',
      referenceNumber: 'RC-000003',
      note: null,
      amountPaise: 200_000,
      balancePaise: 168_000,
    },
  ],
  debitsPaise: 318_000,
  creditsPaise: 200_000,
  closingPaise: 168_000,
  ageing: {
    buckets: {
      not_due: 18_000,
      days_0_30: 100_000,
      days_31_60: 50_000,
      days_61_90: 0,
      days_90_plus: 0,
    },
    outstandingPaise: 168_000,
    unappliedPaise: 0,
    netPaise: 168_000,
  },
  openItems: [
    {
      kind: 'opening',
      number: null,
      raisedOn: '2026-08-01',
      dueOn: '2026-08-15',
      outstandingPaise: 50_000,
      daysPastDue: 57,
    },
    {
      kind: 'invoice',
      number: 'AMP/26-27/000007',
      raisedOn: '2026-09-05',
      dueOn: '2026-10-20',
      outstandingPaise: 118_000,
      daysPastDue: -9,
    },
    {
      kind: 'charge',
      number: null,
      raisedOn: '2026-10-01',
      dueOn: '2026-10-01',
      outstandingPaise: 500,
      daysPastDue: 10,
    },
  ],
};

describe('statement labels', () => {
  it('has every label in every language, with no Latin letters in translations', () => {
    for (const labels of Object.values(STATEMENT_LABELS)) {
      expect(Object.keys(labels).sort()).toEqual(Object.keys(STATEMENT_LABELS.en).sort());
      expect(Object.values(labels).every((text) => text.trim() !== '')).toBe(true);
    }
    for (const language of ['hi', 'te'] as const) {
      const labels = statementLabels(language);
      const latin = STATEMENT_LABEL_KEYS.filter((key) =>
        /[A-Za-z]/.test((labels[key].translation ?? '').replace(/\{\w+\}/g, '')),
      );
      expect(latin).toEqual([]);
    }
  });

  it('borrows the invoice labels it shares and leaves English alone', () => {
    expect(statementLabels(null).statement).toEqual({
      text: 'Statement of Account',
      translation: null,
    });
    expect(statementLabels('hi').statement.translation).toBe('खाता विवरण');
    expect(statementLabels('te').gstin).toEqual({ text: 'GSTIN', translation: null });
    expect(statementLabels('hi').date.translation).not.toBeNull();
  });
});

describe('buildStatementView', () => {
  it('formats every row, total and balance, with Dr and Cr sides', () => {
    const view = buildStatementView(DATA, 'te');
    expect(view.secondLanguage).toBe('te');
    expect(view.business).toEqual({ ...DATA.business });
    expect(view.period).toBe('01 Sep 2026 – 11 Oct 2026');
    expect(view.generatedOn).toBe('11 Oct 2026');
    expect(view.opening).toBe('500.00 Dr');
    expect(view.rows).toEqual([
      {
        date: '05 Sep 2026',
        particulars: 'Invoice',
        reference: 'AMP/26-27/000007',
        note: null,
        debit: '1,180.00',
        credit: '',
        balance: '1,680.00 Dr',
      },
      {
        date: '20 Sep 2026',
        particulars: 'Payment received',
        reference: 'RC-000003',
        note: 'UPI from site',
        debit: '',
        credit: '2,000.00',
        balance: '320.00 Cr',
      },
      {
        date: '01 Oct 2026',
        particulars: 'Cheque bounced',
        reference: 'RC-000003',
        note: null,
        debit: '2,000.00',
        credit: '',
        balance: '1,680.00 Dr',
      },
    ]);
    expect([view.totalDebit, view.totalCredit, view.closing]).toEqual([
      '3,180.00',
      '2,000.00',
      '1,680.00 Dr',
    ]);
    expect(view.ageingOn).toBe('11 Oct 2026');
    expect(view.labels.ageing).toEqual({ text: 'Ageing', translation: 'బకాయి వయస్సు' });
    expect(view.ageing.map((row) => [row.key, row.amount, row.strong])).toEqual([
      ['not_due', '180.00', false],
      ['days_0_30', '1,000.00', false],
      ['days_31_60', '500.00', false],
      ['days_61_90', '0.00', false],
      ['days_90_plus', '0.00', false],
      ['outstanding', '1,680.00', true],
      ['net', '1,680.00 Dr', true],
    ]);
    expect(view.openItems).toEqual([
      {
        reference: 'Opening balance',
        date: '01 Aug 2026',
        dueOn: '15 Aug 2026',
        daysPastDue: '57',
        amount: '500.00',
      },
      {
        reference: 'AMP/26-27/000007',
        date: '05 Sep 2026',
        dueOn: '20 Oct 2026',
        daysPastDue: '',
        amount: '1,180.00',
      },
      {
        reference: 'Charge',
        date: '01 Oct 2026',
        dueOn: '01 Oct 2026',
        daysPastDue: '10',
        amount: '5.00',
      },
    ]);
  });

  it('shows an advance, a credit balance, a zero balance and a single name', () => {
    const view = buildStatementView(
      {
        ...DATA,
        business: { ...DATA.business, legalName: 'Rangoli Paints', gstin: null, address: null },
        openingPaise: 0,
        entries: [],
        closingPaise: -2_500,
        ageing: { ...emptyTotals(), unappliedPaise: 2_500, netPaise: -2_500 },
        openItems: [],
      },
      null,
    );
    expect(view.business.legalName).toBeNull();
    expect(view.labels.period).toEqual({ text: 'Period', translation: null });
    expect([view.opening, view.closing]).toEqual(['0.00', '25.00 Cr']);
    expect(view.ageing.slice(-3).map((row) => [row.key, row.amount])).toEqual([
      ['outstanding', '0.00'],
      ['advance', '25.00'],
      ['net', '25.00 Cr'],
    ]);
  });
});

describe('statementShareText', () => {
  it('says what is due and how much of it is due now, in the statement language', () => {
    expect(statementShareText(DATA, 'en')).toBe(
      'Dear Deccan Contractors, your statement from Rangoli Paints for 01 Sep 2026 to 11 Oct 2026: balance due ₹1,680.00 as of 11 Oct 2026. Of this, ₹1,500.00 is due now. The statement PDF is attached.',
    );
    expect(statementShareText(DATA, 'hi')).toContain('देय बकाया ₹1,680.00');
    expect(statementShareText(DATA, 'te')).toContain('ఇందులో ₹1,500.00');
  });

  it('speaks of an advance, a settled account, and nothing due yet', () => {
    const advance = { ...DATA, ageing: { ...emptyTotals(), unappliedPaise: 900, netPaise: -900 } };
    expect(statementShareText(advance, 'en')).toContain('you have ₹9.00 paid in advance');
    const settled = { ...DATA, ageing: emptyTotals() };
    expect(statementShareText(settled, 'hi')).toContain('कोई बकाया नहीं');
    expect(statementShareText(settled, 'te')).toContain('బకాయి ఏమీ లేదు');
    const notYet = {
      ...DATA,
      ageing: {
        ...emptyTotals(),
        buckets: { ...emptyTotals().buckets, not_due: 700 },
        outstandingPaise: 700,
        netPaise: 700,
      },
    };
    expect(statementShareText(notYet, 'en')).not.toContain('due now');
  });

  it('points to a stored statement link instead of an attachment (MVP 3 round 2a)', () => {
    const url = 'https://app.example.in/s/abc';
    expect(statementShareText(DATA, 'en', url)).toMatch(
      /is due now\. View the statement: https:\/\/app\.example\.in\/s\/abc$/,
    );
    expect(statementShareText(DATA, 'hi', url)).toContain(`खाता विवरण देखें: ${url}`);
    expect(statementShareText(DATA, 'te', url)).toContain(`ఖాతా వివరణ చూడండి: ${url}`);
    expect(statementShareText(DATA, 'en', url)).not.toContain('attached');
  });
});

describe('statementFileName', () => {
  it('names the file after the party and the period, in ASCII', () => {
    expect(statementFileName(DATA)).toBe('Statement-Deccan-Contractors-2026-09-01-2026-10-11.pdf');
    expect(statementFileName({ ...DATA, party: { ...DATA.party, name: 'सुरेश' } })).toBe(
      'Statement-2026-09-01-2026-10-11.pdf',
    );
  });
});
