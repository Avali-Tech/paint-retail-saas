import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TALLY_VOUCHER_TYPES,
  buildTallyExport,
  tallyLedgerTotals,
  tallyLedgersXml,
  tallyVouchersXml,
  tallyWorkbook,
  type TallyEntry,
  type TallyExport,
  type TallySalesDocument,
} from '../index.js';
import {
  SHARMA_LEDGER_RULES,
  sharmaPaintsOctober,
  sharmaPaintsSeptember,
} from './test-support/sharma-paints.js';

/**
 * Golden files for a month of Sharma Paints & Hardware. To regenerate after an
 * intended change: UPDATE_TALLY_GOLDEN=1 pnpm exec vitest run packages/shared/src/tally
 * and review the diff (docs/mvp-2/tally-sample*.xml are what a pilot imports).
 */
const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const doc = (name: string) => new URL(`../../../../docs/mvp-2/${name}`, import.meta.url);
const UPDATE = process.env.UPDATE_TALLY_GOLDEN === '1';

const options = { ledgerRules: SHARMA_LEDGER_RULES, voucherTypes: DEFAULT_TALLY_VOUCHER_TYPES };
const period = sharmaPaintsSeptember();
const data = buildTallyExport(period, options);
const october = buildTallyExport(sharmaPaintsOctober(), options);

function golden(files: readonly URL[], actual: Uint8Array | string) {
  const bytes = typeof actual === 'string' ? new TextEncoder().encode(actual) : actual;
  for (const file of files) {
    if (UPDATE) writeFileSync(file, bytes);
    expect(Buffer.compare(readFileSync(file), Buffer.from(bytes))).toBe(0);
  }
}

describe('Sharma Paints & Hardware, September 2026', () => {
  it('has a month of documents of every kind', () => {
    const count = (kind: TallySalesDocument['kind']) =>
      period.documents.filter((d) => d.kind === kind).length;
    expect(count('tax_invoice')).toBe(40);
    expect(count('credit_note')).toBe(3);
    expect(count('debit_note')).toBe(1);
    expect(period.receipts).toHaveLength(15);
    expect(period.refunds.map((r) => r.receipt.advance)).toEqual([true, false]);
    expect(period.bounces.map((b) => [b.receipt.number, b.chargePaise])).toEqual([
      ['RC-000880', 50000],
    ]);
    expect(new Set(period.receipts.map((r) => r.mode.kind))).toEqual(
      new Set(['cash', 'upi', 'cheque', 'bank_transfer']),
    );
    expect(period.documents.some((d) => d.supplyType === 'inter_state')).toBe(true);
    expect(period.documents.some((d) => d.lines.some((l) => l.nature === 'exempt'))).toBe(true);
    expect(period.documents.some((d) => d.cancelled)).toBe(true);
  });

  it('matches the golden voucher XML, byte for byte', () => {
    golden([fixture('sharma-vouchers.xml'), doc('tally-sample.xml')], tallyVouchersXml(data));
  });

  it('matches the golden ledger masters XML, byte for byte', () => {
    golden(
      [fixture('sharma-ledgers.xml'), doc('tally-sample-ledgers.xml')],
      tallyLedgersXml(data, []),
    );
  });

  it('matches the golden workbook, byte for byte', () => {
    golden([fixture('sharma-vouchers.xlsx')], tallyWorkbook(data));
  });
});

describe('Sharma Paints & Hardware, early October 2026', () => {
  it('reverses a September cheque and pays a walk-in back, and nothing else', () => {
    expect(october.vouchers.map((v) => [v.voucherType, v.number, v.date])).toEqual([
      ['Payment', 'RC-000886', '2026-10-02'],
      ['Journal', 'RC-000884/BOUNCE', '2026-10-03'],
    ]);
  });

  it('matches the golden voucher XML and workbook, byte for byte', () => {
    golden([fixture('sharma-october-vouchers.xml')], tallyVouchersXml(october));
    golden([fixture('sharma-october-vouchers.xlsx')], tallyWorkbook(october));
  });
});

const sum = (entries: readonly TallyEntry[], side: 'debit' | 'credit') =>
  entries.filter((e) => e.side === side).reduce((total, e) => total + e.paise, 0);

/** Net movement on a ledger over the export: credits − debits, or debits − credits. */
const net = (exported: TallyExport, ledger: string, side: 'debit' | 'credit') => {
  const total = tallyLedgerTotals(exported).find((t) => t.ledger === ledger);
  const credit = (total?.creditPaise ?? 0) - (total?.debitPaise ?? 0);
  return side === 'credit' ? credit : -credit + 0;
};
const netCredit = (exported: TallyExport, ledger: string) => net(exported, ledger, 'credit');

describe('invariants on the golden month', () => {
  const live = period.documents.filter((d) => !d.cancelled);
  const sign = (d: TallySalesDocument) => (d.kind === 'credit_note' ? -1 : 1);

  it('balances every voucher: debits equal credits', () => {
    for (const voucher of data.vouchers) {
      expect(sum(voucher.entries, 'debit'), voucher.number).toBe(sum(voucher.entries, 'credit'));
    }
    expect(data.vouchers.filter((v) => v.entries.length === 0).map((v) => v.number)).toEqual([
      'AMP/26-27/000417',
    ]);
  });

  it('posts to each tax and sales ledger exactly the sum of the documents', () => {
    const expected = new Map<string, number>();
    const add = (ledger: string, paise: number) => {
      expected.set(ledger, (expected.get(ledger) ?? 0) + paise);
    };
    for (const d of live) {
      const local = d.supplyType === 'intra_state' ? 'Local' : 'Interstate';
      for (const line of d.lines) {
        const label =
          line.nature === 'exempt' ? 'Exempt' : `GST ${String(line.rateBasisPoints / 100)}%`;
        add(`Sales ${label} ${local}`, sign(d) * line.taxablePaise);
        add('Output CGST 9%', sign(d) * line.cgstPaise);
        add('Output SGST 9%', sign(d) * line.sgstPaise);
        add('Output IGST 18%', sign(d) * line.igstPaise);
      }
    }
    for (const [ledger, paise] of expected) {
      expect(netCredit(data, ledger), ledger).toBe(paise);
    }
    expect(data.ledgers.filter((l) => l.group === 'Sales Accounts').map((l) => l.name)).toEqual([
      'Sales Exempt Interstate',
      'Sales Exempt Local',
      'Sales GST 18% Interstate',
      'Sales GST 18% Local',
    ]);
  });

  it('leaves each party ledger at the spec §4.6 balance rule', () => {
    // invoices + debit notes − credit notes − receipts + refunds + bounced cheques (+ charges)
    const nameOf = (party: { walkIn: boolean; name: string }) =>
      party.walkIn ? 'Cash Sales' : party.name;
    for (const ledger of data.ledgers.filter((l) => l.group === 'Sundry Debtors')) {
      const mine = <T extends { party: { walkIn: boolean; name: string } }>(rows: readonly T[]) =>
        rows.filter((row) => nameOf(row.party) === ledger.name);
      const owed = mine(live).reduce((total, d) => total + sign(d) * d.totalPaise, 0);
      const paid = mine(period.receipts).reduce((total, r) => total + r.amountPaise, 0);
      const back = mine(period.refunds).reduce((total, r) => total + r.amountPaise, 0);
      const bounced = mine(period.bounces).reduce(
        (total, b) => total + b.amountPaise + b.chargePaise,
        0,
      );
      expect(net(data, ledger.name, 'debit'), ledger.name).toBe(owed - paid + back + bounced);
    }
  });

  it('turns a bounced receipt exactly round, reopening the bills it settled', () => {
    const receipt = data.vouchers.find((v) => v.number === 'RC-000880');
    const journal = data.vouchers.find((v) => v.number === 'RC-000880/BOUNCE');
    expect(journal).toMatchObject({ voucherType: 'Journal', date: '2026-09-18', kind: 'journal' });
    expect(journal?.originals).toEqual([{ number: 'RC-000880', issuedOn: '2026-09-15' }]);
    const [mode, party] = receipt?.entries ?? [];
    expect(journal?.entries).toEqual([
      {
        ...party,
        side: 'debit',
        paise: 10050000,
        bills: [
          ...(party?.bills ?? []),
          { type: 'New Ref', name: 'RC-000880/BOUNCE', paise: 50000 },
        ],
      },
      { ...mode, side: 'credit' },
      {
        ledger: 'Cheque Bounce Charges',
        side: 'credit',
        paise: 50000,
        bills: [],
        hsnCodes: [],
        rateBasisPoints: null,
      },
    ]);
  });

  it('pays refunds out of the mode ledger, against the advance or on account', () => {
    const refunds = data.vouchers.filter((v) => v.kind === 'payment');
    expect(
      refunds.map((v) => [
        v.voucherType,
        v.number,
        v.entries.map((e) => [e.ledger, e.side, e.paise, e.bills.map((b) => b.type).join()]),
      ]),
    ).toEqual([
      [
        'Payment',
        'AMPR/26-27/00001',
        [
          ['Lakshmi Interiors', 'debit', 500000, 'Agst Ref'],
          ['UPI Clearing', 'credit', 500000, ''],
        ],
      ],
      [
        'Payment',
        'RC-000885',
        [
          ['Sri Sai Constructions', 'debit', 400000, 'On Account'],
          ['HDFC Bank', 'credit', 400000, ''],
        ],
      ],
    ]);
  });

  it('uses the round-off ledger only for round-off, by the documented amount and side', () => {
    for (const voucher of data.vouchers) {
      const source = live.find((d) => d.id === voucher.documentId);
      const roundOff = voucher.entries.filter((e) => e.ledger === 'Round Off');
      if (source === undefined || source.roundOffPaise === 0) {
        expect(roundOff, voucher.number).toEqual([]);
        continue;
      }
      // A positive round-off adds to what the buyer owes, so it sits opposite the party.
      const partySide = voucher.entries.find((e) => e.ledger === voucher.partyLedger)?.side;
      const opposite = partySide === 'debit' ? 'credit' : 'debit';
      expect(roundOff).toHaveLength(1);
      expect(roundOff[0]?.paise).toBe(Math.abs(source.roundOffPaise));
      expect(roundOff[0]?.side).toBe(source.roundOffPaise > 0 ? opposite : partySide);
    }
    expect(netCredit(data, 'Round Off')).toBe(
      live.reduce((total, d) => total + sign(d) * d.roundOffPaise, 0),
    );
  });

  it('reverses a full return exactly: the credit note mirrors its invoice', () => {
    const note = data.vouchers.find((v) => v.number === 'KKPC/26-27/00001');
    const invoice = data.vouchers.find((v) => v.number === 'KKP/26-27/000242');
    const flip = (entries: readonly TallyEntry[] = []) =>
      entries
        .map((e) => `${e.ledger}|${e.side === 'debit' ? 'credit' : 'debit'}|${String(e.paise)}`)
        .sort();
    const plainEntries = (entries: readonly TallyEntry[] = []) =>
      entries.map((e) => `${e.ledger}|${e.side}|${String(e.paise)}`).sort();
    expect(plainEntries(note?.entries)).toEqual(flip(invoice?.entries));
    expect(note?.originals).toEqual([{ number: 'KKP/26-27/000242', issuedOn: '2026-09-15' }]);
  });

  it('credits the party on every credit note and debits it on every other GST document', () => {
    const gst = data.vouchers.filter((v) => v.gst !== null && !v.cancelled);
    for (const voucher of gst) {
      const party = voucher.entries.find((e) => e.ledger === voucher.partyLedger);
      expect(party?.side, voucher.number).toBe(voucher.kind === 'credit_note' ? 'credit' : 'debit');
    }
  });
});
