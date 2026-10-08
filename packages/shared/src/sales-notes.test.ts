import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GST_OPTIONS,
  computeInvoice,
  computeReturn,
  creditNoteDeadline,
  creditNoteWindow,
  loyaltyPointsToReverse,
  noteSourceOf,
  type StoredInvoiceLine,
} from './index.js';
import { SCENARIO_RATES } from './gst/scenarios.js';

describe('creditNoteDeadline', () => {
  it('is 30 November after the end of the financial year of the supply', () => {
    expect(creditNoteDeadline('2026-04-01')).toBe('2027-11-30');
    expect(creditNoteDeadline('2027-03-31')).toBe('2027-11-30');
    expect(creditNoteDeadline('2026-03-31')).toBe('2026-11-30');
  });
});

describe('creditNoteWindow', () => {
  it('is open, closing within 30 days, and closed after the deadline', () => {
    expect(creditNoteWindow('2026-05-10', '2026-10-08')).toEqual({
      deadline: '2027-11-30',
      status: 'open',
      daysLeft: 418,
    });
    expect(creditNoteWindow('2025-05-10', '2026-10-30')).toEqual({
      deadline: '2026-11-30',
      status: 'open',
      daysLeft: 31,
    });
    expect(creditNoteWindow('2025-05-10', '2026-10-31')).toMatchObject({
      status: 'closing',
      daysLeft: 30,
    });
    expect(creditNoteWindow('2025-05-10', '2026-11-30')).toEqual({
      deadline: '2026-11-30',
      status: 'closing',
      daysLeft: 0,
    });
    expect(creditNoteWindow('2025-05-10', '2026-12-01')).toEqual({
      deadline: '2026-11-30',
      status: 'closed',
      daysLeft: -1,
    });
  });
});

describe('noteSourceOf', () => {
  const invoice = computeInvoice({
    invoiceDate: '2025-10-01',
    registration: 'regular',
    parties: {
      supplierStateCode: '04',
      buyerGstin: null,
      deliveryStateCode: null,
      storeStateCode: '04',
    },
    pricesIncludeTax: true,
    lines: [
      { categoryCode: 'paint', quantity: 3, unitPricePaise: 999_00, discount: null },
      { categoryCode: 'exempt', quantity: 1.25, unitPricePaise: 10_00, discount: null },
    ],
    invoiceDiscount: null,
    rates: SCENARIO_RATES,
    options: DEFAULT_GST_OPTIONS,
  });
  const stored = (line: (typeof invoice.lines)[number]): StoredInvoiceLine => ({
    lineNo: line.index + 1,
    taxCategoryId: line.categoryCode,
    quantity: line.quantityMilli / 1000,
    rateBps: line.rate?.rateBasisPoints ?? null,
    taxablePaise: line.taxablePaise,
    cgstPaise: line.cgstPaise,
    sgstPaise: line.sgstPaise,
    igstPaise: line.igstPaise,
    cessPaise: line.cessPaise,
  });

  it('reads an issued invoice back as the engine charged it, so returns reverse it exactly', () => {
    const source = noteSourceOf({
      supplyType: 'intra_state',
      placeOfSupplyCode: '04',
      lines: invoice.lines.map(stored),
    });
    // Chandigarh (04) is a UT without a legislature: the state half is UTGST.
    expect(source).toMatchObject({ placeOfSupply: '04', stateTaxLabel: 'UTGST' });
    expect(source.lines[1]).toMatchObject({
      index: 2,
      categoryCode: 'exempt',
      quantityMilli: 1250,
      rate: { nature: 'nil_rated', rateBasisPoints: 0, cessBasisPoints: 0 },
    });
    const full = computeReturn(
      source,
      [
        { lineIndex: 1, quantity: 3, previouslyReturnedQuantity: 0 },
        { lineIndex: 2, quantity: 1.25, previouslyReturnedQuantity: 0 },
      ],
      true,
    );
    expect(full.totals.payablePaise).toBe(invoice.totals.payablePaise);
    expect(full.totals.cgstPaise).toBe(invoice.totals.cgstPaise);
  });

  it('keeps a cess rate and a bill of supply’s missing rate, and refuses a draft', () => {
    const [first] = invoice.lines;
    if (!first) throw new Error('The invoice has lines');
    const line = stored(first);
    const source = noteSourceOf({
      supplyType: 'inter_state',
      placeOfSupplyCode: '36',
      lines: [
        { ...line, cessBps: 100 },
        { ...line, lineNo: 2, rateBps: null, taxCategoryId: null },
      ],
    });
    expect(source.stateTaxLabel).toBe('SGST');
    expect(source.lines.map((l) => l.rate)).toEqual([
      { nature: 'taxable', rateBasisPoints: 1800, cessBasisPoints: 100 },
      null,
    ]);
    expect(source.lines[1]?.categoryCode).toBe('null');
    expect(() => noteSourceOf({ supplyType: null, placeOfSupplyCode: null, lines: [] })).toThrow(
      'Only an issued invoice can have notes',
    );
    expect(() =>
      noteSourceOf({ supplyType: 'intra_state', placeOfSupplyCode: null, lines: [] }),
    ).toThrow(RangeError);
  });
});

describe('loyaltyPointsToReverse', () => {
  it('takes back points in proportion to the value credited, never more than earned', () => {
    expect(loyaltyPointsToReverse(100, 10_000_00, 2_500_00)).toBe(25);
    expect(loyaltyPointsToReverse(3, 300_00, 50_00)).toBe(1);
    expect(loyaltyPointsToReverse(10, 1_000_00, 2_000_00)).toBe(10);
    expect(loyaltyPointsToReverse(0, 1_000_00, 500_00)).toBe(0);
    expect(loyaltyPointsToReverse(10, 0, 500_00)).toBe(0);
  });
});
