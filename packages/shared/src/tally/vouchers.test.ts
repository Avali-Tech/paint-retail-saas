import { describe, expect, it } from 'vitest';
import {
  TallyError,
  buildTallyExport,
  checkTallyExport,
  type TallyEntry,
  type TallyExportOptions,
  type TallyPeriod,
} from '../index.js';
import {
  BUYER,
  LINE,
  OPTIONS,
  WALK_IN,
  bounce,
  invoice,
  period,
  receipt,
  refund,
} from './test-support/builders.js';

const entries = (input: TallyPeriod, options: TallyExportOptions = OPTIONS) =>
  buildTallyExport(input, options).vouchers.map((voucher) => voucher.entries);

const entry = (
  ledger: string,
  side: 'debit' | 'credit',
  paise: number,
  more: Partial<TallyEntry> = {},
): TallyEntry => ({
  ledger,
  side,
  paise,
  bills: [],
  hsnCodes: [],
  rateBasisPoints: null,
  ...more,
});

const ORIGINAL = { number: 'AMP/26-27/000001', issuedOn: '2026-09-10' };

describe('sales vouchers', () => {
  it('debits the party with a new bill and credits sales and output tax', () => {
    const data = buildTallyExport(period(), OPTIONS);
    expect(data.vouchers).toEqual([
      {
        kind: 'sales',
        source: 'tax_invoice',
        documentId: 'd1',
        voucherType: 'Sales',
        number: 'AMP/26-27/000001',
        date: '2026-09-10',
        cancelled: false,
        partyLedger: 'Sri Sai Constructions',
        party: BUYER,
        gst: { supplierGstin: invoice().supplierGstin, placeOfSupplyCode: '36' },
        originals: [],
        narration: 'Tax invoice AMP/26-27/000001; [paint:d1]',
        entries: [
          entry('Sri Sai Constructions', 'debit', 118000, {
            bills: [{ type: 'New Ref', name: 'AMP/26-27/000001', paise: 118000 }],
          }),
          entry('Sales GST 18% Local', 'credit', 100000, {
            hsnCodes: ['32091090'],
            rateBasisPoints: 1800,
          }),
          entry('Output CGST 9%', 'credit', 9000, { rateBasisPoints: 900 }),
          entry('Output SGST 9%', 'credit', 9000, { rateBasisPoints: 900 }),
        ],
      },
    ]);
    expect(data.ledgers.map((ledger) => [ledger.name, ledger.group])).toEqual([
      ['Output CGST 9%', 'Duties & Taxes'],
      ['Output SGST 9%', 'Duties & Taxes'],
      ['Sales GST 18% Local', 'Sales Accounts'],
      ['Sri Sai Constructions', 'Sundry Debtors'],
    ]);
  });

  it('adds up lines on one ledger, keeps each HSN once, and leaves out zero tax', () => {
    const exempt = {
      ...LINE,
      hsnCode: '49011010',
      nature: 'exempt' as const,
      rateBasisPoints: 0,
      taxablePaise: 5000,
      cgstPaise: 0,
      sgstPaise: 0,
    };
    const doc = invoice({
      lines: [LINE, { ...LINE, hsnCode: '96034020' }, LINE, exempt],
      totalPaise: 359000,
    });
    expect(entries(period({ documents: [doc] }))[0]).toEqual([
      entry('Sri Sai Constructions', 'debit', 359000, {
        bills: [{ type: 'New Ref', name: doc.number, paise: 359000 }],
      }),
      entry('Sales GST 18% Local', 'credit', 300000, {
        hsnCodes: ['32091090', '96034020'],
        rateBasisPoints: 1800,
      }),
      entry('Sales Exempt Local', 'credit', 5000, { hsnCodes: ['49011010'], rateBasisPoints: 0 }),
      entry('Output CGST 9%', 'credit', 27000, { rateBasisPoints: 900 }),
      entry('Output SGST 9%', 'credit', 27000, { rateBasisPoints: 900 }),
    ]);
  });

  it('puts a negative round-off on the debit side and a positive one on the credit side', () => {
    const down = invoice({ party: WALK_IN, roundOffPaise: -30, totalPaise: 117970 });
    const up = invoice({
      id: 'd2',
      number: 'AMP/26-27/000002',
      party: WALK_IN,
      roundOffPaise: 40,
      totalPaise: 118040,
    });
    const [first, second] = entries(period({ documents: [down, up] }));
    expect(
      first?.filter((e) => e.ledger !== 'Output SGST 9%' && e.ledger !== 'Output CGST 9%'),
    ).toEqual([
      entry('Cash Sales', 'debit', 117970),
      entry('Round Off', 'debit', 30),
      entry('Sales GST 18% Local', 'credit', 100000, {
        hsnCodes: ['32091090'],
        rateBasisPoints: 1800,
      }),
    ]);
    expect(second?.at(-1)).toEqual(entry('Round Off', 'credit', 40));
  });

  it('charges IGST on an inter-state sale and UTGST in a UT without a legislature', () => {
    const inter = invoice({
      placeOfSupplyCode: '37',
      supplyType: 'inter_state',
      lines: [{ ...LINE, cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 }],
    });
    expect(
      entries(period({ documents: [inter] }))[0]
        ?.slice(1)
        .map((e) => e.ledger),
    ).toEqual(['Sales GST 18% Interstate', 'Output IGST 18%']);
    const chandigarh = invoice({
      supplierStateCode: '04',
      placeOfSupplyCode: '04',
      party: WALK_IN,
    });
    expect(
      entries(period({ documents: [chandigarh] }))[0]
        ?.slice(1)
        .map((e) => e.ledger),
    ).toEqual(['Sales GST 18% Local', 'Output CGST 9%', 'Output UTGST 9%']);
  });

  it('posts cess to its own ledger', () => {
    const doc = invoice({
      lines: [{ ...LINE, cessBasisPoints: 100, cessPaise: 1000 }],
      totalPaise: 119000,
    });
    const data = buildTallyExport(period({ documents: [doc] }), OPTIONS);
    expect(data.vouchers[0]?.entries.at(-1)).toEqual(
      entry('Output Cess 1%', 'credit', 1000, { rateBasisPoints: 100 }),
    );
    expect(data.ledgers.find((l) => l.name === 'Output Cess 1%')?.duty).toEqual({
      head: 'Cess',
      rateBasisPoints: 100,
    });
  });

  it('posts a bill of supply to the composition sales ledger, under its own voucher type', () => {
    const doc = invoice({
      kind: 'bill_of_supply',
      lines: [{ ...LINE, rateBasisPoints: 0, cgstPaise: 0, sgstPaise: 0 }],
      totalPaise: 100000,
    });
    const options = {
      ...OPTIONS,
      voucherTypes: { ...OPTIONS.voucherTypes, bill_of_supply: 'Bill of Supply' },
    };
    const [voucher] = buildTallyExport(period({ documents: [doc] }), options).vouchers;
    expect(voucher?.voucherType).toBe('Bill of Supply');
    expect(voucher?.narration).toBe('Bill of supply AMP/26-27/000001; [paint:d1]');
    expect(voucher?.entries.map((e) => [e.ledger, e.side, e.paise])).toEqual([
      ['Sri Sai Constructions', 'debit', 100000],
      ['Sales - Composition', 'credit', 100000],
    ]);
  });

  it('exports a cancelled invoice with its number and no ledger lines', () => {
    const [voucher] = buildTallyExport(
      period({ documents: [invoice({ cancelled: true, note: 'Wrong customer' })] }),
      OPTIONS,
    ).vouchers;
    expect(voucher?.cancelled).toBe(true);
    expect(voucher?.entries).toEqual([]);
    expect(voucher?.narration).toBe(
      'Tax invoice AMP/26-27/000001; CANCELLED; Wrong customer; [paint:d1]',
    );
  });
});

describe('notes', () => {
  it('mirrors a sale on a credit note, settling the bills it names and the rest on account', () => {
    const note = invoice({
      kind: 'credit_note',
      number: 'AMPC/26-27/00001',
      roundOffPaise: -20,
      totalPaise: 117980,
      originals: [ORIGINAL, { number: 'AMP/26-27/000002', issuedOn: '2026-09-11' }],
      allocations: [{ documentNumber: ORIGINAL.number, amountPaise: 100000 }],
      note: 'Return',
    });
    const [voucher] = buildTallyExport(period({ documents: [note] }), OPTIONS).vouchers;
    expect(voucher?.voucherType).toBe('Credit Note');
    expect(voucher?.narration).toBe(
      'Credit note AMPC/26-27/00001; against AMP/26-27/000001 dated 10-09-2026, AMP/26-27/000002 dated 11-09-2026; Return; [paint:d1]',
    );
    expect(voucher?.entries).toEqual([
      entry('Sales GST 18% Local', 'debit', 100000, {
        hsnCodes: ['32091090'],
        rateBasisPoints: 1800,
      }),
      entry('Output CGST 9%', 'debit', 9000, { rateBasisPoints: 900 }),
      entry('Output SGST 9%', 'debit', 9000, { rateBasisPoints: 900 }),
      entry('Sri Sai Constructions', 'credit', 117980, {
        bills: [
          { type: 'Agst Ref', name: ORIGINAL.number, paise: 100000 },
          { type: 'On Account', name: '', paise: 17980 },
        ],
      }),
      entry('Round Off', 'credit', 20),
    ]);
  });

  it('treats a debit note as a sale with its own new bill', () => {
    const note = invoice({ kind: 'debit_note', number: 'AMPD/26-27/00001', originals: [ORIGINAL] });
    const [voucher] = buildTallyExport(period({ documents: [note] }), OPTIONS).vouchers;
    expect(voucher?.voucherType).toBe('Debit Note');
    expect(voucher?.entries[0]).toEqual(
      entry('Sri Sai Constructions', 'debit', 118000, {
        bills: [{ type: 'New Ref', name: 'AMPD/26-27/00001', paise: 118000 }],
      }),
    );
  });
});

describe('receipts', () => {
  it('debits the mode ledger and credits the party against its bills, the rest on account', () => {
    const paid = receipt({
      mode: { kind: 'upi', name: 'UPI' },
      amountPaise: 150000,
      reference: 'UTR 1',
      note: 'Part payment',
      allocations: [{ documentNumber: ORIGINAL.number, amountPaise: 118000 }],
    });
    const [voucher] = buildTallyExport(
      period({ documents: [], receipts: [paid] }),
      OPTIONS,
    ).vouchers;
    expect(voucher?.gst).toBeNull();
    expect(voucher?.narration).toBe(
      'Receipt RC-000001 by UPI; ref UTR 1; Part payment; [paint:r1]',
    );
    expect(voucher?.entries).toEqual([
      entry('UPI Clearing', 'debit', 150000),
      entry('Sri Sai Constructions', 'credit', 150000, {
        bills: [
          { type: 'Agst Ref', name: ORIGINAL.number, paise: 118000 },
          { type: 'On Account', name: '', paise: 32000 },
        ],
      }),
    ]);
  });

  it('records an advance under its receipt voucher number and keeps no bills for walk-ins', () => {
    const advance = receipt({ number: 'AMPA/26-27/00001', advance: true });
    const counter = receipt({
      id: 'r2',
      number: 'RC-000002',
      party: WALK_IN,
      allocations: [{ documentNumber: 'X', amountPaise: 1 }],
    });
    const [first, second] = entries(period({ documents: [], receipts: [advance, counter] }));
    expect(first?.[1]?.bills).toEqual([
      { type: 'Advance', name: 'AMPA/26-27/00001', paise: 118000 },
    ]);
    expect(second?.[1]).toEqual(entry('Cash Sales', 'credit', 118000));
  });

  it('allocates nothing extra when the bills take the whole receipt', () => {
    const exact = receipt({
      allocations: [{ documentNumber: ORIGINAL.number, amountPaise: 118000 }],
    });
    expect(entries(period({ documents: [], receipts: [exact] }))[0]?.[1]?.bills).toEqual([
      { type: 'Agst Ref', name: ORIGINAL.number, paise: 118000 },
    ]);
  });
});

describe('refunds', () => {
  it('pays an advance back as a Payment voucher: Dr party against the advance, Cr the mode', () => {
    const [voucher] = buildTallyExport(
      period({ documents: [], refunds: [refund({ reference: 'UTR 9', note: 'Order cut' })] }),
      OPTIONS,
    ).vouchers;
    expect(voucher).toMatchObject({
      kind: 'payment',
      source: 'refund',
      voucherType: 'Payment',
      number: 'AMPR/26-27/00001',
      date: '2026-09-20',
      partyLedger: 'Sri Sai Constructions',
      gst: null,
      originals: [{ number: 'AMPA/26-27/00001', issuedOn: '2026-09-12' }],
    });
    expect(voucher?.narration).toBe(
      'Refund AMPR/26-27/00001 by UPI; against receipt AMPA/26-27/00001 dated 12-09-2026; ref UTR 9; Order cut; [paint:f1]',
    );
    expect(voucher?.entries).toEqual([
      entry('Sri Sai Constructions', 'debit', 50000, {
        bills: [{ type: 'Agst Ref', name: 'AMPA/26-27/00001', paise: 50000 }],
      }),
      entry('UPI Clearing', 'credit', 50000),
    ]);
  });

  it('pays back money on account on account, and keeps no bills for walk-ins', () => {
    const onAccount = refund({
      receipt: { number: 'RC-000001', receivedOn: '2026-09-12', advance: false },
      mode: { kind: 'cash', name: 'Cash' },
    });
    const counter = refund({ id: 'f2', number: 'RC-000009', party: WALK_IN });
    const [first, second] = entries(period({ documents: [], refunds: [onAccount, counter] }));
    expect(first).toEqual([
      entry('Sri Sai Constructions', 'debit', 50000, {
        bills: [{ type: 'On Account', name: '', paise: 50000 }],
      }),
      entry('Cash', 'credit', 50000),
    ]);
    expect(second?.[0]).toEqual(entry('Cash Sales', 'debit', 50000));
  });
});

describe('bounced cheques', () => {
  it('reverses the receipt as a Journal on the bounce date, reopening its bills', () => {
    const [voucher] = buildTallyExport(
      period({ documents: [], bounces: [bounce()] }),
      OPTIONS,
    ).vouchers;
    expect(voucher).toMatchObject({
      kind: 'journal',
      source: 'cheque_bounce',
      voucherType: 'Journal',
      documentId: 'r1-bounce',
      number: 'RC-000001/BOUNCE',
      date: '2026-09-15',
      gst: null,
      originals: [{ number: 'RC-000001', issuedOn: '2026-09-12' }],
    });
    expect(voucher?.narration).toBe(
      'Cheque bounced: receipt RC-000001 dated 12-09-2026 by Cheque; ref Cheque 004512; Funds insufficient; [paint:r1-bounce]',
    );
    expect(voucher?.entries).toEqual([
      entry('Sri Sai Constructions', 'debit', 118000, {
        bills: [{ type: 'Agst Ref', name: 'AMP/26-27/000001', paise: 118000 }],
      }),
      entry('Cheques in Hand', 'credit', 118000),
    ]);
  });

  it('charges the party a new bill for a bounce charge, credited to bounce charges', () => {
    const charged = bounce({
      reference: null,
      amountPaise: 150000,
      chargePaise: 59000,
      receipt: { number: 'AMPA/26-27/00002', receivedOn: '2026-09-12', advance: true },
    });
    const [voucher] = buildTallyExport(
      period({ documents: [], bounces: [charged] }),
      OPTIONS,
    ).vouchers;
    expect(voucher?.narration).toBe(
      'Cheque bounced: receipt AMPA/26-27/00002 dated 12-09-2026 by Cheque; Funds insufficient; bounce charge Rs 590.00; [paint:r1-bounce]',
    );
    expect(voucher?.entries).toEqual([
      entry('Sri Sai Constructions', 'debit', 209000, {
        bills: [
          { type: 'Agst Ref', name: 'AMP/26-27/000001', paise: 118000 },
          { type: 'Agst Ref', name: 'AMPA/26-27/00002', paise: 32000 },
          { type: 'New Ref', name: 'AMPA/26-27/00002/BOUNCE', paise: 59000 },
        ],
      }),
      entry('Cheques in Hand', 'credit', 150000),
      entry('Cheque Bounce Charges', 'credit', 59000),
    ]);
  });

  it('keeps no bills for a walk-in cheque, charge or not', () => {
    const walkIn = bounce({ party: WALK_IN, reopened: [], chargePaise: 10000 });
    expect(entries(period({ documents: [], bounces: [walkIn] }))[0]).toEqual([
      entry('Cash Sales', 'debit', 128000),
      entry('Cheques in Hand', 'credit', 118000),
      entry('Cheque Bounce Charges', 'credit', 10000),
    ]);
  });
});

describe('voucher order', () => {
  it('sorts by date, then sales, debit notes, credit notes, receipts, payments, journals, then number', () => {
    const data = buildTallyExport(
      period({
        documents: [
          invoice({ id: 'a', number: 'B-2', issuedOn: '2026-09-11' }),
          invoice({ id: 'b', number: 'B-1', issuedOn: '2026-09-11' }),
          invoice({
            id: 'c',
            number: 'B-1',
            issuedOn: '2026-09-11',
            kind: 'bill_of_supply',
            lines: [{ ...LINE, rateBasisPoints: 0, cgstPaise: 0, sgstPaise: 0 }],
            totalPaise: 100000,
          }),
          invoice({ id: 'd', kind: 'credit_note', number: 'C-1', originals: [ORIGINAL] }),
          invoice({ id: 'e', kind: 'debit_note', number: 'D-1', originals: [ORIGINAL] }),
          invoice({ id: 'f', number: 'A-9', issuedOn: '2026-09-02' }),
        ],
        receipts: [receipt({ receivedOn: '2026-09-10' })],
        refunds: [
          refund({
            paidOn: '2026-09-10',
            receipt: { ...refund().receipt, receivedOn: '2026-09-10' },
          }),
        ],
        bounces: [
          bounce({
            bouncedOn: '2026-09-10',
            receipt: { ...bounce().receipt, receivedOn: '2026-09-10' },
          }),
        ],
      }),
      OPTIONS,
    );
    expect(data.vouchers.map((v) => v.documentId)).toEqual([
      'f',
      'e',
      'd',
      'r1',
      'f1',
      'r1-bounce',
      'b',
      'c',
      'a',
    ]);
  });
});

describe('ledger problems', () => {
  const problemsOf = (input: TallyPeriod, options: TallyExportOptions = OPTIONS) =>
    checkTallyExport(input, options);

  it('lists every unmapped ledger once', () => {
    const neft = receipt({ mode: { kind: 'bank_transfer', name: 'NEFT' } });
    const finance = receipt({
      id: 'r2',
      number: 'RC-2',
      mode: { kind: 'other', name: 'Bajaj Finance' },
    });
    const again = receipt({
      id: 'r3',
      number: 'RC-3',
      mode: { kind: 'bank_transfer', name: 'NEFT' },
    });
    expect(problemsOf(period({ receipts: [neft, finance, again] }))).toEqual([
      {
        code: 'unmapped_ledger',
        document: null,
        message:
          'No Tally ledger is mapped for payment mode "NEFT" (bank_transfer); add a payment_mode mapping',
      },
      {
        code: 'unmapped_ledger',
        document: null,
        message:
          'No Tally ledger is mapped for payment mode "Bajaj Finance" (other); add a payment_mode mapping',
      },
    ]);
  });

  it('refuses a blank or padded ledger name', () => {
    const options = {
      ...OPTIONS,
      ledgerRules: [
        { purpose: 'round_off' as const, ledgerName: 'Round Off ' },
        { purpose: 'sales' as const, ledgerName: ' ' },
      ],
    };
    const doc = invoice({ roundOffPaise: 10, totalPaise: 118010 });
    expect(problemsOf(period({ documents: [doc] }), options).map((p) => p.message)).toEqual([
      'The ledger name " " for sales at GST 18% (local) is blank or has outer spaces',
      'The ledger name "Round Off " for round-off is blank or has outer spaces',
    ]);
  });

  it('refuses one ledger for two parties, two tax heads, or two groups', () => {
    const twin = { ...BUYER, id: 'b2', gstin: null, stateCode: null };
    const docs = [invoice(), invoice({ id: 'd2', number: 'AMP/26-27/000002', party: twin })];
    expect(problemsOf(period({ documents: docs })).map((p) => p.message)).toEqual([
      'The ledger "Sri Sai Constructions" is mapped for both party "Sri Sai Constructions" and party "Sri Sai Constructions"',
    ]);
    const oneTax = {
      ...OPTIONS,
      ledgerRules: [{ purpose: 'output_sgst' as const, ledgerName: 'Output CGST 9%' }],
    };
    expect(problemsOf(period(), oneTax).map((p) => p.code)).toEqual(['ledger_conflict']);
    const bank = {
      ...OPTIONS,
      ledgerRules: [{ purpose: 'payment_mode' as const, ledgerName: 'HDFC Bank' }],
    };
    const upi = receipt({ id: 'r2', number: 'RC-2', mode: { kind: 'upi', name: 'UPI' } });
    expect(problemsOf(period({ receipts: [receipt(), upi] }), bank).map((p) => p.message)).toEqual([
      'The ledger "HDFC Bank" is mapped for both payment mode "Cash" (cash) and payment mode "UPI" (upi)',
    ]);
    const sameGroup = {
      ...OPTIONS,
      ledgerRules: [
        {
          purpose: 'payment_mode' as const,
          ledgerName: 'HDFC Bank',
          group: 'Bank Accounts' as const,
        },
      ],
    };
    expect(problemsOf(period({ receipts: [receipt(), upi] }), sameGroup)).toEqual([]);
  });

  it('throws a TallyError listing every problem', () => {
    const neft = receipt({ mode: { kind: 'bank_transfer', name: 'NEFT' } });
    const build = () => buildTallyExport(period({ receipts: [neft] }), OPTIONS);
    expect(build).toThrow(TallyError);
    expect(build).toThrow(
      'The Tally export has 1 problem(s):\n- No Tally ledger is mapped for payment mode "NEFT" (bank_transfer); add a payment_mode mapping',
    );
    expect(() => buildTallyExport(period({ from: 'x' }), OPTIONS)).toThrow(
      expect.objectContaining({
        name: 'TallyError',
        problems: [expect.objectContaining({ code: 'invalid_period' })],
      }),
    );
  });
});
