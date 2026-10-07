import { describe, expect, it } from 'vitest';
import { checkTallyExport, type TallyPeriod, type TallyProblemCode } from '../index.js';
import { BUYER, LINE, OPTIONS, invoice, period, receipt } from './test-support/builders.js';
import { isIsoDate } from './validate.js';

const codes = (input: TallyPeriod): TallyProblemCode[] =>
  checkTallyExport(input, OPTIONS).map((problem) => problem.code);

describe('isIsoDate', () => {
  it('accepts real dates only', () => {
    expect(isIsoDate('2026-09-30')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-1')).toBe(false);
  });
});

describe('input checks', () => {
  it('accepts a balanced period', () => {
    expect(checkTallyExport(period(), OPTIONS)).toEqual([]);
  });

  it('refuses a period that is not a date range, and stops there', () => {
    expect(checkTallyExport(period({ from: '2026-10-01' }), OPTIONS)).toEqual([
      {
        code: 'invalid_period',
        document: null,
        message: 'The period 2026-10-01 to 2026-09-30 is not a date range',
      },
    ]);
    expect(codes(period({ from: 'September' }))).toEqual(['invalid_period']);
    expect(codes(period({ to: '2026-09-31' }))).toEqual(['invalid_period']);
  });

  it('refuses a blank company name', () => {
    expect(codes(period({ companyName: '  ' }))).toEqual(['invalid_period']);
  });

  it('refuses documents and receipts dated outside the period', () => {
    expect(
      checkTallyExport(
        period({
          documents: [invoice({ issuedOn: '2026-10-01' })],
          receipts: [receipt({ receivedOn: '2026-02-30' })],
        }),
        OPTIONS,
      ).map((problem) => problem.message),
    ).toEqual([
      'AMP/26-27/000001 is dated 2026-10-01, outside 2026-09-01 to 2026-09-30',
      'RC-000001 is dated 2026-02-30, outside 2026-09-01 to 2026-09-30',
    ]);
  });

  it('refuses an invalid party GSTIN or state code', () => {
    const party = { ...BUYER, gstin: '36AAMFS7310K1Z0', stateCode: '99' };
    expect(codes(period({ documents: [invoice({ party })] }))).toEqual([
      'tax_mismatch',
      'tax_mismatch',
    ]);
    expect(codes(period({ documents: [], receipts: [receipt({ party })] }))).toEqual([
      'tax_mismatch',
      'tax_mismatch',
    ]);
  });

  it('refuses an unknown supplier state or place of supply', () => {
    expect(codes(period({ documents: [invoice({ supplierStateCode: '00' })] }))).toEqual([
      'tax_mismatch',
    ]);
    expect(codes(period({ documents: [invoice({ placeOfSupplyCode: '40' })] }))).toEqual([
      'tax_mismatch',
    ]);
  });

  it('refuses amounts that are not whole paise, and round-off beyond a rupee', () => {
    const bad = (overrides: Parameters<typeof invoice>[0]) =>
      codes(period({ documents: [invoice(overrides)] }));
    expect(bad({ lines: [{ ...LINE, taxablePaise: -1 }] })).toEqual(['invalid_amount']);
    expect(bad({ lines: [{ ...LINE, cgstPaise: 0.5 }] })).toEqual(['invalid_amount']);
    expect(bad({ totalPaise: -5 })).toEqual(['invalid_amount']);
    expect(bad({ roundOffPaise: 1.5 })).toEqual(['invalid_amount']);
    expect(bad({ roundOffPaise: -50, totalPaise: 117950 })).toEqual(['invalid_amount']);
    expect(bad({ roundOffPaise: 51, totalPaise: 118051 })).toEqual(['invalid_amount']);
    expect(bad({ roundOffPaise: -49, totalPaise: 117951 })).toEqual([]);
    expect(bad({ roundOffPaise: 50, totalPaise: 118050 })).toEqual([]);
  });

  it('refuses a total that is not the lines plus the round-off', () => {
    expect(
      checkTallyExport(period({ documents: [invoice({ totalPaise: 118001 })] }), OPTIONS),
    ).toEqual([
      {
        code: 'totals_mismatch',
        document: 'AMP/26-27/000001',
        message:
          'AMP/26-27/000001: lines and round-off add up to 118000 paise, not the total 118001',
      },
    ]);
  });

  it('refuses a supply type that contradicts the place of supply', () => {
    expect(codes(period({ documents: [invoice({ placeOfSupplyCode: '37' })] }))).toEqual([
      'tax_mismatch',
    ]);
  });

  it('refuses tax heads that the supply cannot carry', () => {
    const igstLocal = invoice({
      lines: [{ ...LINE, cgstPaise: 0, sgstPaise: 0, igstPaise: 18000 }],
    });
    expect(codes(period({ documents: [igstLocal] }))).toEqual(['tax_mismatch']);
    const cgstInter = invoice({ placeOfSupplyCode: '37', supplyType: 'inter_state' });
    expect(codes(period({ documents: [cgstInter] }))).toEqual(['tax_mismatch']);
    const taxedExempt = invoice({ lines: [{ ...LINE, nature: 'exempt' }] });
    expect(codes(period({ documents: [taxedExempt] }))).toEqual(['tax_mismatch']);
    const ratedExempt = invoice({
      lines: [{ ...LINE, nature: 'exempt', cgstPaise: 0, sgstPaise: 0 }],
      totalPaise: 100000,
    });
    expect(codes(period({ documents: [ratedExempt] }))).toEqual(['tax_mismatch']);
    const taxedSupply = invoice({ kind: 'bill_of_supply' });
    expect(codes(period({ documents: [taxedSupply] }))).toEqual(['tax_mismatch']);
  });

  it('refuses a note that names no original invoice', () => {
    expect(codes(period({ documents: [invoice({ kind: 'credit_note' })] }))).toEqual([
      'missing_original',
    ]);
    expect(codes(period({ documents: [invoice({ kind: 'debit_note' })] }))).toEqual([
      'missing_original',
    ]);
  });

  it('refuses allocations that are not positive or exceed the amount', () => {
    const allocate = (amountPaise: number) => [{ documentNumber: 'X', amountPaise }];
    expect(
      codes(period({ documents: [], receipts: [receipt({ allocations: allocate(0) })] })),
    ).toEqual(['invalid_amount']);
    expect(
      codes(period({ documents: [], receipts: [receipt({ allocations: allocate(-1) })] })),
    ).toEqual(['invalid_amount']);
    expect(
      codes(period({ documents: [], receipts: [receipt({ allocations: allocate(118001) })] })),
    ).toEqual(['over_allocated']);
    const note = invoice({
      kind: 'credit_note',
      originals: [{ number: 'AMP/26-27/000000', issuedOn: '2026-09-01' }],
      allocations: allocate(118001),
    });
    expect(codes(period({ documents: [note] }))).toEqual(['over_allocated']);
  });

  it('refuses a receipt of nothing', () => {
    expect(codes(period({ documents: [], receipts: [receipt({ amountPaise: 0 })] }))).toEqual([
      'invalid_amount',
    ]);
  });

  it('refuses the same number twice for one kind and GSTIN', () => {
    expect(
      codes(
        period({
          documents: [
            invoice(),
            invoice({ id: 'd2' }),
            invoice({ id: 'd3', kind: 'bill_of_supply', lines: [], totalPaise: 0 }),
          ],
          receipts: [receipt(), receipt({ id: 'r2' })],
        }),
      ),
    ).toEqual(['duplicate_number', 'duplicate_number']);
  });
});
