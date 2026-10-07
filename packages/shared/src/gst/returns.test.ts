import { describe, expect, it } from 'vitest';
import { DEFAULT_GST_OPTIONS, computeInvoice, computeReturn } from '../index.js';
import { SCENARIO_RATES } from './scenarios.js';

const invoice = computeInvoice({
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
});

describe('computeReturn', () => {
  it('reverses a full return of every line to the paisa, round-off included', () => {
    const note = computeReturn(
      invoice,
      [
        { lineIndex: 0, quantity: 3, previouslyReturnedQuantity: 0 },
        { lineIndex: 1, quantity: 2.5, previouslyReturnedQuantity: 0 },
      ],
      true,
    );
    const { grossPaise, lineDiscountPaise, invoiceDiscountPaise, ...originalTotals } =
      invoice.totals;
    expect(note.totals).toEqual(originalTotals);
    expect(note.taxSummary).toEqual(invoice.taxSummary);
    expect(note.amountInWords).toBe(invoice.amountInWords);
    expect(note).toMatchObject({
      supplyType: 'intra_state',
      placeOfSupply: '36',
      stateTaxLabel: 'SGST',
    });
    expect(note.lines[1]).toMatchObject({
      lineIndex: 1,
      categoryCode: 'tools',
      quantityMilli: 2500,
    });
  });

  it('reverses a fractional part-return in proportion', () => {
    const tools = invoice.lines[1];
    const note = computeReturn(
      invoice,
      [{ lineIndex: 1, quantity: 0.5, previouslyReturnedQuantity: 2 }],
      false,
    );
    // Remaining 0.5 of 2.5: original less round(original × 2/2.5).
    const rest = (paise = 0) => paise - Math.round((paise * 4) / 5);
    expect(note.lines[0]).toMatchObject({
      taxablePaise: rest(tools?.taxablePaise),
      cgstPaise: rest(tools?.cgstPaise),
    });
  });

  it('refuses nothing, a repeated line, an unknown line and over-returns', () => {
    expect(() => computeReturn(invoice, [], false)).toThrow('Nothing is being returned');
    expect(() =>
      computeReturn(
        invoice,
        [
          { lineIndex: 0, quantity: 1, previouslyReturnedQuantity: 0 },
          { lineIndex: 0, quantity: 1, previouslyReturnedQuantity: 0 },
        ],
        false,
      ),
    ).toThrow('Line 0 is listed twice');
    expect(() =>
      computeReturn(invoice, [{ lineIndex: 5, quantity: 1, previouslyReturnedQuantity: 0 }], false),
    ).toThrow('The invoice has no line 5');
    expect(() =>
      computeReturn(
        invoice,
        [{ lineIndex: 0, quantity: 2, previouslyReturnedQuantity: 1.5 }],
        false,
      ),
    ).toThrow('More of line 0 returned than sold');
    expect(() =>
      computeReturn(invoice, [{ lineIndex: 0, quantity: 0, previouslyReturnedQuantity: 0 }], false),
    ).toThrow(expect.objectContaining({ code: 'invalid_quantity' }));
  });

  it('a composition bill of supply returns with no tax summary', () => {
    const bill = computeInvoice({ ...invoiceInputForComposition() });
    const note = computeReturn(
      bill,
      [{ lineIndex: 0, quantity: 1, previouslyReturnedQuantity: 0 }],
      false,
    );
    expect(note.taxSummary).toEqual([]);
    expect(note.totals).toMatchObject({ taxablePaise: 500_00, taxPaise: 0 });
  });
});

function invoiceInputForComposition() {
  return {
    invoiceDate: '2025-10-01',
    registration: 'composition' as const,
    parties: {
      supplierStateCode: '36',
      buyerGstin: null,
      deliveryStateCode: null,
      storeStateCode: '36',
    },
    pricesIncludeTax: true,
    lines: [{ categoryCode: 'paint', quantity: 2, unitPricePaise: 500_00, discount: null }],
    invoiceDiscount: null,
    rates: [],
    options: DEFAULT_GST_OPTIONS,
  };
}
