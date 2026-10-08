import { describe, expect, it } from 'vitest';
import { DEFAULT_GST_OPTIONS, GstError, computeAdjustment, computeInvoice } from '../index.js';
import type { InvoiceInput } from './invoice.js';
import { SCENARIO_RATES } from './scenarios.js';

const input = (overrides: Partial<InvoiceInput> = {}): InvoiceInput => ({
  invoiceDate: '2025-10-01',
  registration: 'regular',
  parties: {
    supplierStateCode: '36',
    buyerGstin: null,
    deliveryStateCode: null,
    storeStateCode: '36',
  },
  pricesIncludeTax: true,
  lines: [
    { categoryCode: 'paint', quantity: 3, unitPricePaise: 999_00, discount: null },
    { categoryCode: 'tools', quantity: 2.5, unitPricePaise: 33_33, discount: null },
  ],
  invoiceDiscount: null,
  rates: SCENARIO_RATES,
  options: DEFAULT_GST_OPTIONS,
  ...overrides,
});
const invoice = computeInvoice(input());

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof GstError ? error.code : 'not a GstError';
  }
  return 'no error';
};

describe('computeAdjustment', () => {
  it('taxes each value at the rate its original line was charged, inclusive or not', () => {
    const note = computeAdjustment(invoice, [{ lineIndex: 0, valuePaise: 118_00 }], true, true);
    // ₹118 including 18%: ₹100 taxable, ₹9 CGST, ₹9 SGST.
    expect(note.lines).toEqual([
      {
        lineIndex: 0,
        categoryCode: 'paint',
        quantityMilli: 3000,
        rate: { nature: 'taxable', rateBasisPoints: 1800, cessBasisPoints: 0 },
        taxablePaise: 100_00,
        cgstPaise: 9_00,
        sgstPaise: 9_00,
        igstPaise: 0,
        cessPaise: 0,
        taxPaise: 18_00,
        totalPaise: 118_00,
      },
    ]);
    expect(note).toMatchObject({
      supplyType: 'intra_state',
      placeOfSupply: '36',
      stateTaxLabel: 'SGST',
      amountInWords: 'Rupees One Hundred Eighteen Only',
    });

    // Exclusive values: the tools line keeps its 5% (the rate on the invoice date).
    const exclusive = computeAdjustment(
      invoice,
      [
        { lineIndex: 1, valuePaise: 100_00 },
        { lineIndex: 0, valuePaise: 10_01 },
      ],
      false,
      true,
    );
    expect(exclusive.lines.map((line) => [line.cgstPaise, line.totalPaise])).toEqual([
      [2_50, 105_00],
      [90, 11_81],
    ]);
    expect(exclusive.totals).toEqual({
      taxablePaise: 110_01,
      cgstPaise: 3_40,
      sgstPaise: 3_40,
      igstPaise: 0,
      cessPaise: 0,
      taxPaise: 6_80,
      totalPaise: 116_81,
      roundOffPaise: 19,
      payablePaise: 117_00,
    });
    expect(exclusive.taxSummary.map((row) => row.rateBasisPoints)).toEqual([500, 1800]);
    expect(
      computeAdjustment(invoice, [{ lineIndex: 0, valuePaise: 10_01 }], false, false).totals
        .payablePaise,
    ).toBe(11_81);
  });

  it('keeps the original supply: IGST inter-state, no tax on a bill of supply', () => {
    const interState = computeInvoice(
      input({
        parties: {
          supplierStateCode: '36',
          buyerGstin: null,
          deliveryStateCode: '37',
          storeStateCode: '36',
        },
      }),
    );
    const note = computeAdjustment(interState, [{ lineIndex: 0, valuePaise: 100_00 }], false, true);
    expect(note.totals).toMatchObject({ igstPaise: 18_00, cgstPaise: 0, payablePaise: 118_00 });
    expect(note.supplyType).toBe('inter_state');

    const billOfSupply = computeInvoice(input({ registration: 'composition' }));
    const untaxed = computeAdjustment(
      billOfSupply,
      [{ lineIndex: 1, valuePaise: 500_00 }],
      true,
      true,
    );
    expect(untaxed.lines[0]).toMatchObject({ rate: null, taxablePaise: 500_00, taxPaise: 0 });
    expect(untaxed.taxSummary).toEqual([]);
  });

  it('refuses nothing, a line twice, an unknown line and a value of zero or less', () => {
    expect(refusal(() => computeAdjustment(invoice, [], true, true))).toBe('invalid_adjustment');
    expect(
      refusal(() =>
        computeAdjustment(
          invoice,
          [
            { lineIndex: 0, valuePaise: 1 },
            { lineIndex: 0, valuePaise: 2 },
          ],
          true,
          true,
        ),
      ),
    ).toBe('invalid_adjustment');
    expect(
      refusal(() => computeAdjustment(invoice, [{ lineIndex: 9, valuePaise: 1 }], true, true)),
    ).toBe('invalid_adjustment');
    expect(
      refusal(() => computeAdjustment(invoice, [{ lineIndex: 0, valuePaise: 0 }], true, true)),
    ).toBe('invalid_adjustment');
    expect(
      refusal(() => computeAdjustment(invoice, [{ lineIndex: 0, valuePaise: -5 }], true, true)),
    ).toBe('invalid_amount');
  });
});
