import { describe, expect, it } from 'vitest';
import { buildTallyExport, tallyLedgerTotals } from '../index.js';
import { OPTIONS, WALK_IN, invoice, period, receipt } from './test-support/builders.js';
import { tallySheets } from './workbook.js';

const data = buildTallyExport(
  period({
    documents: [
      invoice(),
      invoice({ id: 'd2', number: 'AMP/26-27/000002', cancelled: true, party: WALK_IN }),
      invoice({
        id: 'd3',
        kind: 'credit_note',
        number: 'AMPC/26-27/00001',
        originals: [{ number: 'AMP/26-27/000001', issuedOn: '2026-09-10' }],
      }),
    ],
    receipts: [
      receipt({ allocations: [{ documentNumber: 'AMP/26-27/000001', amountPaise: 100000 }] }),
    ],
  }),
  OPTIONS,
);

describe('tallyLedgerTotals', () => {
  it('adds up each ledger, a ledger used only by a cancelled voucher at zero', () => {
    expect(tallyLedgerTotals(data)).toEqual([
      { ledger: 'Cash', debitPaise: 118000, creditPaise: 0 },
      { ledger: 'Cash Sales', debitPaise: 0, creditPaise: 0 },
      { ledger: 'Output CGST 9%', debitPaise: 9000, creditPaise: 9000 },
      { ledger: 'Output SGST 9%', debitPaise: 9000, creditPaise: 9000 },
      { ledger: 'Sales GST 18% Local', debitPaise: 100000, creditPaise: 100000 },
      { ledger: 'Sri Sai Constructions', debitPaise: 118000, creditPaise: 236000 },
    ]);
  });
});

describe('tallySheets', () => {
  const sheets = tallySheets(data);
  const sheet = (name: string) => sheets.find((s) => s.name === name);

  it('has one sheet per voucher type and a ledger sheet', () => {
    expect(sheets.map((s) => [s.name, s.rows.length])).toEqual([
      ['Sales', 5],
      ['Credit Note', 4],
      ['Debit Note', 0],
      ['Receipt', 2],
      ['Ledgers', 6],
    ]);
  });

  it('writes one row per ledger line, and one bare row for a cancelled voucher', () => {
    const rows = sheet('Sales')?.rows ?? [];
    const text = (value: string) => ({ kind: 'text', value });
    expect(rows[0]).toEqual([
      { kind: 'date', iso: '2026-09-10' },
      text('Sales'),
      text('AMP/26-27/000001'),
      text('No'),
      text('Sri Sai Constructions'),
      text(String(invoice().party.gstin)),
      text('Telangana'),
      null,
      text('Sri Sai Constructions'),
      null,
      null,
      { kind: 'amount', paise: 118000 },
      null,
      text('New Ref AMP/26-27/000001 1180.00'),
      text('Tax invoice AMP/26-27/000001; [paint:d1]'),
    ]);
    expect(rows[1]?.slice(8, 13)).toEqual([
      text('Sales GST 18% Local'),
      text('32091090'),
      text('18'),
      null,
      { kind: 'amount', paise: 100000 },
    ]);
    expect(rows[4]?.slice(2, 13)).toEqual([
      text('AMP/26-27/000002'),
      text('Yes'),
      text('Cash Sales'),
      null,
      text('Telangana'),
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(sheet('Credit Note')?.rows[0]?.[7]).toEqual(text('AMP/26-27/000001 (2026-09-10)'));
    expect(sheet('Receipt')?.rows[1]?.[13]).toEqual(
      text('Agst Ref AMP/26-27/000001 1000.00; On Account 180.00'),
    );
    expect(sheet('Receipt')?.rows[0]?.[6]).toBeNull();
  });

  it('lists the ledgers with their group, GST details and totals', () => {
    const rows = sheet('Ledgers')?.rows ?? [];
    const text = (value: string) => ({ kind: 'text', value });
    expect(rows[2]).toEqual([
      text('Output CGST 9%'),
      text('Duties & Taxes'),
      text('No'),
      null,
      null,
      text('CGST'),
      text('9'),
      { kind: 'amount', paise: 9000 },
      { kind: 'amount', paise: 9000 },
    ]);
    expect(rows[5]?.slice(0, 7)).toEqual([
      text('Sri Sai Constructions'),
      text('Sundry Debtors'),
      text('Yes'),
      text(String(invoice().party.gstin)),
      text('Telangana'),
      null,
      null,
    ]);
  });
});
