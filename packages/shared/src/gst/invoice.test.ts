import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GST_OPTIONS,
  computeInvoice,
  type GstRate,
  type InvoiceInput,
  type LineInput,
} from '../index.js';
import { SCENARIO_RATES } from './scenarios.js';

const line = (categoryCode: string, quantity: number, unitPricePaise: number): LineInput => ({
  categoryCode,
  quantity,
  unitPricePaise,
  discount: null,
});

const base: InvoiceInput = {
  invoiceDate: '2025-10-01',
  registration: 'regular',
  parties: {
    supplierStateCode: '36',
    buyerGstin: null,
    deliveryStateCode: null,
    storeStateCode: '36',
  },
  pricesIncludeTax: false,
  lines: [line('paint', 1, 100_00)],
  invoiceDiscount: null,
  rates: SCENARIO_RATES,
  options: DEFAULT_GST_OPTIONS,
};

const RATES: GstRate[] = [
  ...SCENARIO_RATES,
  {
    categoryCode: 'nil',
    nature: 'nil_rated',
    rateBasisPoints: 0,
    cessBasisPoints: 0,
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
];

describe('computeInvoice', () => {
  it('returns every field of a simple invoice', () => {
    expect(computeInvoice(base)).toEqual({
      documentType: 'tax_invoice',
      buyerType: 'b2c',
      placeOfSupply: '36',
      supplyType: 'intra_state',
      stateTaxLabel: 'SGST',
      pricesIncludeTax: false,
      lines: [
        {
          index: 0,
          categoryCode: 'paint',
          quantityMilli: 1000,
          unitPricePaise: 100_00,
          grossPaise: 100_00,
          lineDiscountPaise: 0,
          invoiceDiscountPaise: 0,
          rate: { nature: 'taxable', rateBasisPoints: 1800, cessBasisPoints: 0 },
          taxablePaise: 100_00,
          cgstPaise: 9_00,
          sgstPaise: 9_00,
          igstPaise: 0,
          cessPaise: 0,
          taxPaise: 18_00,
          totalPaise: 118_00,
        },
      ],
      taxSummary: [
        {
          nature: 'taxable',
          rateBasisPoints: 1800,
          cessBasisPoints: 0,
          taxablePaise: 100_00,
          cgstPaise: 9_00,
          sgstPaise: 9_00,
          igstPaise: 0,
          cessPaise: 0,
          taxPaise: 18_00,
        },
      ],
      totals: {
        grossPaise: 100_00,
        lineDiscountPaise: 0,
        invoiceDiscountPaise: 0,
        taxablePaise: 100_00,
        cgstPaise: 9_00,
        sgstPaise: 9_00,
        igstPaise: 0,
        cessPaise: 0,
        taxPaise: 18_00,
        totalPaise: 118_00,
        roundOffPaise: 0,
        payablePaise: 118_00,
      },
      amountInWords: 'Rupees One Hundred Eighteen Only',
    });
  });

  it('orders the tax summary by rate, then cess, then nature', () => {
    const invoice = computeInvoice({
      ...base,
      rates: RATES,
      lines: [
        line('cess-demo', 1, 100_00),
        line('paint', 1, 100_00),
        line('nil', 1, 10_00),
        line('exempt', 1, 20_00),
        line('paint', 1, 50_00),
      ],
    });
    expect(
      invoice.taxSummary.map(({ nature, rateBasisPoints, cessBasisPoints, taxablePaise }) => [
        nature,
        rateBasisPoints,
        cessBasisPoints,
        taxablePaise,
      ]),
    ).toEqual([
      ['exempt', 0, 0, 20_00],
      ['nil_rated', 0, 0, 10_00],
      ['taxable', 1800, 0, 150_00],
      ['taxable', 1800, 100, 100_00],
    ]);
  });

  it('applies a percentage invoice discount after line discounts', () => {
    const invoice = computeInvoice({
      ...base,
      lines: [
        { ...line('paint', 1, 1_000_00), discount: { kind: 'amount', paise: 100_00 } },
        line('tools', 1, 100_00),
      ],
      invoiceDiscount: { kind: 'percent', basisPoints: 1000 },
    });
    // Nets ₹900 + ₹100 = ₹1,000; 10% = ₹100, split ₹90 / ₹10.
    expect(invoice.lines.map((l) => [l.invoiceDiscountPaise, l.taxablePaise])).toEqual([
      [90_00, 810_00],
      [10_00, 90_00],
    ]);
    expect(invoice.totals).toMatchObject({
      lineDiscountPaise: 100_00,
      invoiceDiscountPaise: 100_00,
      taxablePaise: 900_00,
    });
  });

  it('a 100% invoice discount leaves a zero invoice', () => {
    const invoice = computeInvoice({
      ...base,
      invoiceDiscount: { kind: 'percent', basisPoints: 10_000 },
    });
    expect(invoice.totals).toMatchObject({ taxablePaise: 0, taxPaise: 0, payablePaise: 0 });
    expect(invoice.amountInWords).toBe('Rupees Zero Only');
  });

  it('invoice-level rounding keeps rates in separate groups, IGST included', () => {
    const invoice = computeInvoice({
      ...base,
      options: { taxRounding: 'invoice', roundOff: false },
      parties: { ...base.parties, deliveryStateCode: '27' },
      lines: [
        line('paint', 1, 10_05),
        line('tools', 1, 10_05),
        line('paint', 1, 10_05),
        line('cess-demo', 1, 10_05),
      ],
    });
    // Paint: ₹20.10 × 18% = ₹3.618 → ₹3.62, split 181/181; tools ₹10.05 × 5% = 50.25 → 50.
    expect(invoice.lines.map((l) => [l.igstPaise, l.cessPaise])).toEqual([
      [181, 0],
      [50, 0],
      [181, 0],
      [181, 10],
    ]);
    expect(invoice.totals.igstPaise).toBe(593);
  });

  it('invoice-level rounding with every line discounted away', () => {
    const invoice = computeInvoice({
      ...base,
      options: { taxRounding: 'invoice', roundOff: true },
      lines: [{ ...line('paint', 1, 100), discount: { kind: 'percent', basisPoints: 10_000 } }],
    });
    expect(invoice.lines[0]).toMatchObject({ taxablePaise: 0, cgstPaise: 0, totalPaise: 0 });
  });

  it('round-off can be switched off', () => {
    const invoice = computeInvoice({
      ...base,
      options: { ...DEFAULT_GST_OPTIONS, roundOff: false },
      lines: [line('paint', 1, 13_13)],
    });
    expect(invoice.totals).toMatchObject({
      totalPaise: 15_49,
      roundOffPaise: 0,
      payablePaise: 15_49,
    });
    expect(invoice.amountInWords).toBe('Rupees Fifteen and Forty-Nine Paise Only');
  });

  it('refuses a composition dealer selling inter-state', () => {
    expect(() =>
      computeInvoice({
        ...base,
        registration: 'composition',
        parties: { ...base.parties, deliveryStateCode: '27' },
      }),
    ).toThrow(expect.objectContaining({ code: 'composition_inter_state' }));
  });

  it('does not need a rate table for a composition dealer', () => {
    const invoice = computeInvoice({
      ...base,
      registration: 'composition',
      rates: [],
      lines: [line('unlisted', 1, 50_00)],
    });
    expect(invoice).toMatchObject({ documentType: 'bill_of_supply', taxSummary: [] });
    expect(invoice.totals).toMatchObject({ taxablePaise: 50_00, taxPaise: 0, payablePaise: 50_00 });
  });

  it('refuses invoice-level rounding with inclusive prices', () => {
    expect(() =>
      computeInvoice({
        ...base,
        pricesIncludeTax: true,
        options: { taxRounding: 'invoice', roundOff: true },
      }),
    ).toThrow('Invoice-level rounding needs tax-exclusive prices');
  });

  it('refuses an empty invoice, an unknown category or a bad date', () => {
    expect(() => computeInvoice({ ...base, lines: [] })).toThrow(
      'An invoice needs at least one line',
    );
    expect(() => computeInvoice({ ...base, lines: [line('glue', 1, 1)] })).toThrow(
      expect.objectContaining({ code: 'no_rate' }),
    );
    expect(() => computeInvoice({ ...base, invoiceDate: '01-10-2025' })).toThrow(
      expect.objectContaining({ code: 'invalid_date' }),
    );
  });

  it('refuses an invoice discount larger than the bill', () => {
    expect(() =>
      computeInvoice({ ...base, invoiceDiscount: { kind: 'amount', paise: 100_01 } }),
    ).toThrow(expect.objectContaining({ code: 'discount_exceeds_value' }));
  });
});
