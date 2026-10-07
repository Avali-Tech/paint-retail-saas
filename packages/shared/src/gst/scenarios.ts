import type { InvoiceInput, InvoiceLine, InvoiceTotals } from './invoice.js';
import type { LineInput } from './line.js';
import type { Parties } from './place-of-supply.js';
import type { CreditNoteLine, ReturnLineInput } from './returns.js';
import type { DocumentTotals, TaxSummaryRow } from './summary.js';
import { DEFAULT_GST_OPTIONS, type GstOptions, type GstRate } from './types.js';

/**
 * Hand-checked GST scenarios for a CA to review (roadmap P2-M01: "done when an
 * automated test suite of CA-reviewed scenarios passes"). Each `working` line
 * shows the arithmetic in rupees; every amount in `expected` is in paise.
 *
 * The rate table is ILLUSTRATIVE test data, not a statement of current law:
 * paint's 28% → 18% change on 27 July 2018 is real; the tools 12% → 5% change
 * on 22 September 2025 stands in for any slab change; `cess-demo` exercises the
 * cess hook. Rounding is half up to the paisa; see `index.ts` for the rules.
 */
export const SCENARIO_RATES: readonly GstRate[] = [
  rate('paint', 2800, '2017-07-01', '2018-07-26'),
  rate('paint', 1800, '2018-07-27', null),
  rate('tools', 1200, '2017-07-01', '2025-09-21'),
  rate('tools', 500, '2025-09-22', null),
  rate('cess-demo', 1800, '2017-07-01', null, 100),
  { ...rate('exempt', 0, '2017-07-01', null), nature: 'exempt' },
];

function rate(
  categoryCode: string,
  rateBasisPoints: number,
  effectiveFrom: string,
  effectiveTo: string | null,
  cessBasisPoints = 0,
): GstRate {
  return {
    categoryCode,
    nature: 'taxable',
    rateBasisPoints,
    cessBasisPoints,
    effectiveFrom,
    effectiveTo,
  };
}

/** Valid GSTINs (correct check character) for the parties below. */
export const SCENARIO_GSTINS = {
  telanganaBuyer: '36AAACT9876Q1Z9',
  maharashtraBuyer: '27AAFCR5678K1ZP',
  chandigarhBuyer: '04AAACC4321D1ZI',
} as const;

/** A walk-in at the Hyderabad (Telangana, 36) store. */
const COUNTER: Parties = {
  supplierStateCode: '36',
  buyerGstin: null,
  deliveryStateCode: null,
  storeStateCode: '36',
};
const B2B_INTRA: Parties = { ...COUNTER, buyerGstin: SCENARIO_GSTINS.telanganaBuyer };
const B2B_INTER: Parties = { ...COUNTER, buyerGstin: SCENARIO_GSTINS.maharashtraBuyer };

const line = (categoryCode: string, quantity: number, unitPricePaise: number): LineInput => ({
  categoryCode,
  quantity,
  unitPricePaise,
  discount: null,
});

function invoice(overrides: Partial<InvoiceInput> & Pick<InvoiceInput, 'lines'>): InvoiceInput {
  return {
    invoiceDate: '2025-10-01',
    registration: 'regular',
    parties: COUNTER,
    pricesIncludeTax: false,
    invoiceDiscount: null,
    rates: SCENARIO_RATES,
    options: DEFAULT_GST_OPTIONS,
    ...overrides,
  };
}

const NO_ROUNDING: GstOptions = { ...DEFAULT_GST_OPTIONS, roundOff: false };
const INVOICE_ROUNDING: GstOptions = { ...DEFAULT_GST_OPTIONS, taxRounding: 'invoice' };

/** Every head of the totals, with the derived tax, total and payable. */
function totals(
  heads: Omit<InvoiceTotals, 'taxPaise' | 'totalPaise' | 'payablePaise' | 'roundOffPaise'>,
  roundOffPaise: number,
): InvoiceTotals {
  const taxPaise = heads.cgstPaise + heads.sgstPaise + heads.igstPaise + heads.cessPaise;
  const totalPaise = heads.taxablePaise + taxPaise;
  return {
    ...heads,
    taxPaise,
    totalPaise,
    roundOffPaise,
    payablePaise: totalPaise + roundOffPaise,
  };
}

export interface InvoiceScenario {
  readonly id: string;
  readonly title: string;
  /** The hand calculation, in rupees. */
  readonly working: string;
  readonly input: InvoiceInput;
  readonly expected: {
    readonly documentType: 'tax_invoice' | 'bill_of_supply';
    readonly supplyType: 'intra_state' | 'inter_state';
    readonly stateTaxLabel: 'SGST' | 'UTGST';
    readonly lines: readonly Partial<InvoiceLine>[];
    readonly totals: InvoiceTotals;
    readonly taxSummary?: readonly Partial<TaxSummaryRow>[];
    readonly amountInWords: string;
  };
}

const intra = {
  documentType: 'tax_invoice',
  supplyType: 'intra_state',
  stateTaxLabel: 'SGST',
} as const;
const inter = {
  documentType: 'tax_invoice',
  supplyType: 'inter_state',
  stateTaxLabel: 'SGST',
} as const;
const zeroDiscounts = { lineDiscountPaise: 0, invoiceDiscountPaise: 0 };

export const INVOICE_SCENARIOS: readonly InvoiceScenario[] = [
  {
    id: 'S01',
    title: 'Counter sale in Telangana, tax added: CGST + SGST at 9% each',
    working: '2 × ₹1,000 = ₹2,000; CGST 9% = ₹180; SGST ₹180; total ₹2,360',
    input: invoice({ lines: [line('paint', 2, 1_000_00)] }),
    expected: {
      ...intra,
      lines: [
        { grossPaise: 2_000_00, taxablePaise: 2_000_00, cgstPaise: 180_00, sgstPaise: 180_00 },
      ],
      totals: totals(
        {
          grossPaise: 2_000_00,
          ...zeroDiscounts,
          taxablePaise: 2_000_00,
          cgstPaise: 180_00,
          sgstPaise: 180_00,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees Two Thousand Three Hundred Sixty Only',
    },
  },
  {
    id: 'S02',
    title: 'B2B to a Maharashtra GSTIN, 10% line discount: IGST 18%, rounded up 30 paise',
    working:
      '3 × ₹450 = ₹1,350; less 10% = ₹135 → ₹1,215; IGST 18% = ₹218.70; ₹1,433.70 → ₹1,434.00',
    input: invoice({
      parties: B2B_INTER,
      lines: [{ ...line('paint', 3, 450_00), discount: { kind: 'percent', basisPoints: 1000 } }],
    }),
    expected: {
      ...inter,
      lines: [
        {
          grossPaise: 1_350_00,
          lineDiscountPaise: 135_00,
          taxablePaise: 1_215_00,
          igstPaise: 218_70,
        },
      ],
      totals: totals(
        {
          grossPaise: 1_350_00,
          lineDiscountPaise: 135_00,
          invoiceDiscountPaise: 0,
          taxablePaise: 1_215_00,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 218_70,
          cessPaise: 0,
        },
        30,
      ),
      amountInWords: 'Rupees One Thousand Four Hundred Thirty-Four Only',
    },
  },
  {
    id: 'S03',
    title: 'Tax-inclusive shelf price that divides exactly',
    working: '₹1,180 incl. 18% → taxable ₹1,180 × 100/118 = ₹1,000; CGST ₹90; SGST ₹90',
    input: invoice({ pricesIncludeTax: true, lines: [line('paint', 1, 1_180_00)] }),
    expected: {
      ...intra,
      lines: [
        {
          grossPaise: 1_180_00,
          taxablePaise: 1_000_00,
          cgstPaise: 90_00,
          sgstPaise: 90_00,
          totalPaise: 1_180_00,
        },
      ],
      totals: totals(
        {
          grossPaise: 1_180_00,
          ...zeroDiscounts,
          taxablePaise: 1_000_00,
          cgstPaise: 90_00,
          sgstPaise: 90_00,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees One Thousand One Hundred Eighty Only',
    },
  },
  {
    id: 'S04',
    title: 'Tax-inclusive ₹999: the odd paisa stays in the taxable value, the price is unchanged',
    working:
      '₹999 × 100/118 = ₹846.610… → ₹846.61; 9% of that = ₹76.1949 → ₹76.19 each; tax ₹152.38; taxable = ₹999 − ₹152.38 = ₹846.62',
    input: invoice({ pricesIncludeTax: true, lines: [line('paint', 1, 999_00)] }),
    expected: {
      ...intra,
      lines: [{ taxablePaise: 846_62, cgstPaise: 76_19, sgstPaise: 76_19, totalPaise: 999_00 }],
      totals: totals(
        {
          grossPaise: 999_00,
          ...zeroDiscounts,
          taxablePaise: 846_62,
          cgstPaise: 76_19,
          sgstPaise: 76_19,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees Nine Hundred Ninety-Nine Only',
    },
  },
  {
    id: 'S05',
    title: 'Odd paise: each half is rounded on its own, so CGST = SGST',
    working: '₹10.25 × 9% = ₹0.9225 → ₹0.92 each; GST ₹1.84 (18% once would be ₹1.845 → ₹1.85)',
    input: invoice({ options: NO_ROUNDING, lines: [line('paint', 1, 10_25)] }),
    expected: {
      ...intra,
      lines: [{ taxablePaise: 10_25, cgstPaise: 92, sgstPaise: 92 }],
      totals: totals(
        {
          grossPaise: 10_25,
          ...zeroDiscounts,
          taxablePaise: 10_25,
          cgstPaise: 92,
          sgstPaise: 92,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees Twelve and Nine Paise Only',
    },
  },
  {
    id: 'S06',
    title: 'Half a paisa rounds up; total ₹12.40 rounds down to ₹12',
    working: '₹10.50 × 9% = ₹0.945 → ₹0.95 each; total ₹12.40; round-off −₹0.40',
    input: invoice({ lines: [line('paint', 1, 10_50)] }),
    expected: {
      ...intra,
      lines: [{ cgstPaise: 95, sgstPaise: 95 }],
      totals: totals(
        {
          grossPaise: 10_50,
          ...zeroDiscounts,
          taxablePaise: 10_50,
          cgstPaise: 95,
          sgstPaise: 95,
          igstPaise: 0,
          cessPaise: 0,
        },
        -40,
      ),
      amountInWords: 'Rupees Twelve Only',
    },
  },
  {
    id: 'S07',
    title: 'Round-off at exactly ₹0.50 goes up',
    working: '₹125 + ₹11.25 + ₹11.25 = ₹147.50 → ₹148.00 (+₹0.50)',
    input: invoice({ lines: [line('paint', 1, 125_00)] }),
    expected: {
      ...intra,
      lines: [{ cgstPaise: 11_25, sgstPaise: 11_25 }],
      totals: totals(
        {
          grossPaise: 125_00,
          ...zeroDiscounts,
          taxablePaise: 125_00,
          cgstPaise: 11_25,
          sgstPaise: 11_25,
          igstPaise: 0,
          cessPaise: 0,
        },
        50,
      ),
      amountInWords: 'Rupees One Hundred Forty-Eight Only',
    },
  },
  {
    id: 'S08',
    title: 'Round-off at ₹0.49 goes down',
    working: '₹13.13 × 9% = ₹1.1817 → ₹1.18 each; total ₹15.49 → ₹15.00 (−₹0.49)',
    input: invoice({ lines: [line('paint', 1, 13_13)] }),
    expected: {
      ...intra,
      lines: [{ cgstPaise: 1_18, sgstPaise: 1_18 }],
      totals: totals(
        {
          grossPaise: 13_13,
          ...zeroDiscounts,
          taxablePaise: 13_13,
          cgstPaise: 1_18,
          sgstPaise: 1_18,
          igstPaise: 0,
          cessPaise: 0,
        },
        -49,
      ),
      amountInWords: 'Rupees Fifteen Only',
    },
  },
  {
    id: 'S09',
    title: 'Composition dealer: a bill of supply, no tax collected',
    working: '2 × ₹500 = ₹1,000; no tax on the bill',
    input: invoice({
      registration: 'composition',
      pricesIncludeTax: true,
      lines: [line('paint', 2, 500_00)],
    }),
    expected: {
      ...intra,
      documentType: 'bill_of_supply',
      lines: [{ taxablePaise: 1_000_00, cgstPaise: 0, sgstPaise: 0, rate: null }],
      totals: totals(
        {
          grossPaise: 1_000_00,
          ...zeroDiscounts,
          taxablePaise: 1_000_00,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      taxSummary: [],
      amountInWords: 'Rupees One Thousand Only',
    },
  },
  {
    id: 'S10',
    title: 'Last day of the old rate: paint at 28% on 26 July 2018',
    working: '₹100 × 14% = ₹14 each; total ₹128',
    input: invoice({ invoiceDate: '2018-07-26', lines: [line('paint', 1, 100_00)] }),
    expected: {
      ...intra,
      lines: [
        {
          rate: { nature: 'taxable', rateBasisPoints: 2800, cessBasisPoints: 0 },
          cgstPaise: 14_00,
        },
      ],
      totals: totals(
        {
          grossPaise: 100_00,
          ...zeroDiscounts,
          taxablePaise: 100_00,
          cgstPaise: 14_00,
          sgstPaise: 14_00,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees One Hundred Twenty-Eight Only',
    },
  },
  {
    id: 'S11',
    title: 'First day of the new rate: paint at 18% on 27 July 2018, B2B within Telangana',
    working: '₹100 × 9% = ₹9 each; total ₹118',
    input: invoice({
      invoiceDate: '2018-07-27',
      parties: B2B_INTRA,
      lines: [line('paint', 1, 100_00)],
    }),
    expected: {
      ...intra,
      lines: [
        { rate: { nature: 'taxable', rateBasisPoints: 1800, cessBasisPoints: 0 }, cgstPaise: 9_00 },
      ],
      totals: totals(
        {
          grossPaise: 100_00,
          ...zeroDiscounts,
          taxablePaise: 100_00,
          cgstPaise: 9_00,
          sgstPaise: 9_00,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees One Hundred Eighteen Only',
    },
  },
  {
    id: 'S12',
    title: 'Invoice discount of ₹100 spread over three lines in proportion',
    working:
      'Lines ₹100, ₹200, ₹300; ₹100 × 1/6 = ₹16.666…, 2/6 = ₹33.333…, 3/6 = ₹50; floors leave 1 paisa, to the largest remainder (line 1): ₹16.67, ₹33.33, ₹50. Taxable ₹83.33, ₹166.67, ₹250; CGST 9% = ₹7.4997 → ₹7.50, ₹15.0003 → ₹15.00, ₹22.50',
    input: invoice({
      lines: [line('paint', 1, 100_00), line('paint', 2, 100_00), line('paint', 3, 100_00)],
      invoiceDiscount: { kind: 'amount', paise: 100_00 },
    }),
    expected: {
      ...intra,
      lines: [
        { invoiceDiscountPaise: 16_67, taxablePaise: 83_33, cgstPaise: 7_50, sgstPaise: 7_50 },
        { invoiceDiscountPaise: 33_33, taxablePaise: 166_67, cgstPaise: 15_00, sgstPaise: 15_00 },
        { invoiceDiscountPaise: 50_00, taxablePaise: 250_00, cgstPaise: 22_50, sgstPaise: 22_50 },
      ],
      totals: totals(
        {
          grossPaise: 600_00,
          lineDiscountPaise: 0,
          invoiceDiscountPaise: 100_00,
          taxablePaise: 500_00,
          cgstPaise: 45_00,
          sgstPaise: 45_00,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees Five Hundred Ninety Only',
    },
  },
  {
    id: 'S13',
    title: 'Per-line rounding (default): three ₹10.05 lines',
    working: '₹10.05 × 9% = ₹0.9045 → ₹0.90 per line; CGST ₹2.70; total ₹35.55 → ₹36 (+₹0.45)',
    input: invoice({
      lines: [line('paint', 1, 10_05), line('paint', 1, 10_05), line('paint', 1, 10_05)],
    }),
    expected: {
      ...intra,
      lines: [{ cgstPaise: 90 }, { cgstPaise: 90 }, { cgstPaise: 90 }],
      totals: totals(
        {
          grossPaise: 30_15,
          ...zeroDiscounts,
          taxablePaise: 30_15,
          cgstPaise: 2_70,
          sgstPaise: 2_70,
          igstPaise: 0,
          cessPaise: 0,
        },
        45,
      ),
      amountInWords: 'Rupees Thirty-Six Only',
    },
  },
  {
    id: 'S14',
    title: 'Invoice-level rounding: the same three lines, tax rounded once per rate',
    working:
      '₹30.15 × 9% = ₹2.7135 → ₹2.71 per half, spread equally: ₹0.91, ₹0.90, ₹0.90 (tie → first line); total ₹35.57 → ₹36 (+₹0.43)',
    input: invoice({
      options: INVOICE_ROUNDING,
      lines: [line('paint', 1, 10_05), line('paint', 1, 10_05), line('paint', 1, 10_05)],
    }),
    expected: {
      ...intra,
      lines: [
        { cgstPaise: 91, sgstPaise: 91 },
        { cgstPaise: 90, sgstPaise: 90 },
        { cgstPaise: 90, sgstPaise: 90 },
      ],
      totals: totals(
        {
          grossPaise: 30_15,
          ...zeroDiscounts,
          taxablePaise: 30_15,
          cgstPaise: 2_71,
          sgstPaise: 2_71,
          igstPaise: 0,
          cessPaise: 0,
        },
        43,
      ),
      amountInWords: 'Rupees Thirty-Six Only',
    },
  },
  {
    id: 'S15',
    title: 'Mixed rates: tax summary per rate, exempt line first',
    working:
      'Paint ₹1,000 → ₹90 + ₹90; tools 2 × ₹50 = ₹100 at 5% → ₹2.50 + ₹2.50; exempt ₹20; total ₹1,305',
    input: invoice({
      lines: [line('paint', 1, 1_000_00), line('tools', 2, 50_00), line('exempt', 1, 20_00)],
    }),
    expected: {
      ...intra,
      lines: [{ cgstPaise: 90_00 }, { cgstPaise: 2_50 }, { cgstPaise: 0 }],
      totals: totals(
        {
          grossPaise: 1_120_00,
          ...zeroDiscounts,
          taxablePaise: 1_120_00,
          cgstPaise: 92_50,
          sgstPaise: 92_50,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      taxSummary: [
        { nature: 'exempt', rateBasisPoints: 0, taxablePaise: 20_00, taxPaise: 0 },
        {
          nature: 'taxable',
          rateBasisPoints: 500,
          taxablePaise: 100_00,
          cgstPaise: 2_50,
          taxPaise: 5_00,
        },
        {
          nature: 'taxable',
          rateBasisPoints: 1800,
          taxablePaise: 1_000_00,
          cgstPaise: 90_00,
          taxPaise: 180_00,
        },
      ],
      amountInWords: 'Rupees One Thousand Three Hundred Five Only',
    },
  },
  {
    id: 'S16',
    title: 'Chandigarh (UT without a legislature): CGST + UTGST',
    working: '₹200 × 9% = ₹18 each; total ₹236',
    input: invoice({
      parties: {
        ...COUNTER,
        supplierStateCode: '04',
        storeStateCode: '04',
        buyerGstin: SCENARIO_GSTINS.chandigarhBuyer,
      },
      lines: [line('paint', 1, 200_00)],
    }),
    expected: {
      ...intra,
      stateTaxLabel: 'UTGST',
      lines: [{ cgstPaise: 18_00, sgstPaise: 18_00 }],
      totals: totals(
        {
          grossPaise: 200_00,
          ...zeroDiscounts,
          taxablePaise: 200_00,
          cgstPaise: 18_00,
          sgstPaise: 18_00,
          igstPaise: 0,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees Two Hundred Thirty-Six Only',
    },
  },
  {
    id: 'S17',
    title: 'B2C delivered to Maharashtra: IGST, with the cess hook at 1%',
    working: '₹100 → IGST 18% ₹18, cess 1% ₹1; total ₹119',
    input: invoice({
      parties: { ...COUNTER, deliveryStateCode: '27' },
      lines: [line('cess-demo', 1, 100_00)],
    }),
    expected: {
      ...inter,
      lines: [{ igstPaise: 18_00, cessPaise: 1_00, cgstPaise: 0 }],
      totals: totals(
        {
          grossPaise: 100_00,
          ...zeroDiscounts,
          taxablePaise: 100_00,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 18_00,
          cessPaise: 1_00,
        },
        0,
      ),
      amountInWords: 'Rupees One Hundred Nineteen Only',
    },
  },
  {
    id: 'S18',
    title: 'Loose quantity: 2.5 litres at ₹333.33',
    working:
      '2.5 × ₹333.33 = ₹833.325 → ₹833.33; IGST ₹149.9994 → ₹150.00; ₹983.33 → ₹983 (−₹0.33)',
    input: invoice({ parties: B2B_INTER, lines: [line('paint', 2.5, 333_33)] }),
    expected: {
      ...inter,
      lines: [{ quantityMilli: 2500, grossPaise: 833_33, igstPaise: 150_00 }],
      totals: totals(
        {
          grossPaise: 833_33,
          ...zeroDiscounts,
          taxablePaise: 833_33,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 150_00,
          cessPaise: 0,
        },
        -33,
      ),
      amountInWords: 'Rupees Nine Hundred Eighty-Three Only',
    },
  },
  {
    id: 'S19',
    title: 'Inclusive price, ₹18 line discount, inter-state B2B',
    working:
      '2 × ₹590 = ₹1,180 − ₹18 = ₹1,162; × 100/118 = ₹984.745… → ₹984.75; IGST 18% = ₹177.255 → ₹177.26; taxable ₹1,162 − ₹177.26 = ₹984.74',
    input: invoice({
      parties: B2B_INTER,
      pricesIncludeTax: true,
      lines: [{ ...line('paint', 2, 590_00), discount: { kind: 'amount', paise: 18_00 } }],
    }),
    expected: {
      ...inter,
      lines: [
        { lineDiscountPaise: 18_00, taxablePaise: 984_74, igstPaise: 177_26, totalPaise: 1_162_00 },
      ],
      totals: totals(
        {
          grossPaise: 1_180_00,
          lineDiscountPaise: 18_00,
          invoiceDiscountPaise: 0,
          taxablePaise: 984_74,
          cgstPaise: 0,
          sgstPaise: 0,
          igstPaise: 177_26,
          cessPaise: 0,
        },
        0,
      ),
      amountInWords: 'Rupees One Thousand One Hundred Sixty-Two Only',
    },
  },
];

export interface ReturnScenario {
  readonly id: string;
  readonly title: string;
  readonly working: string;
  /** The original invoice, by scenario id. */
  readonly invoiceId: string;
  readonly returned: readonly ReturnLineInput[];
  readonly roundOff: boolean;
  readonly expected: {
    readonly lines: readonly Partial<CreditNoteLine>[];
    readonly totals: Partial<DocumentTotals>;
  };
}

export const RETURN_SCENARIOS: readonly ReturnScenario[] = [
  {
    id: 'R01',
    title: 'S12, line 3: first of three single-unit returns',
    working: 'Taxable ₹250 × 1/3 = ₹83.333 → ₹83.33; CGST ₹22.50 × 1/3 = ₹7.50',
    invoiceId: 'S12',
    returned: [{ lineIndex: 2, quantity: 1, previouslyReturnedQuantity: 0 }],
    roundOff: false,
    expected: {
      lines: [{ taxablePaise: 83_33, cgstPaise: 7_50, sgstPaise: 7_50 }],
      totals: { taxablePaise: 83_33, taxPaise: 15_00, payablePaise: 98_33 },
    },
  },
  {
    id: 'R02',
    title: 'S12, line 3: second unit (one already returned)',
    working: '₹250 × 2/3 = ₹166.667 → ₹166.67, less ₹83.33 = ₹83.34; CGST ₹15 − ₹7.50 = ₹7.50',
    invoiceId: 'S12',
    returned: [{ lineIndex: 2, quantity: 1, previouslyReturnedQuantity: 1 }],
    roundOff: false,
    expected: {
      lines: [{ taxablePaise: 83_34, cgstPaise: 7_50, sgstPaise: 7_50 }],
      totals: { taxablePaise: 83_34, taxPaise: 15_00, payablePaise: 98_34 },
    },
  },
  {
    id: 'R03',
    title: 'S12, line 3: last unit; the three notes add up to the line exactly',
    working: '₹250 − ₹166.67 = ₹83.33; notes: ₹83.33 + ₹83.34 + ₹83.33 = ₹250',
    invoiceId: 'S12',
    returned: [{ lineIndex: 2, quantity: 1, previouslyReturnedQuantity: 2 }],
    roundOff: false,
    expected: {
      lines: [{ taxablePaise: 83_33, cgstPaise: 7_50, sgstPaise: 7_50 }],
      totals: { taxablePaise: 83_33, taxPaise: 15_00, payablePaise: 98_33 },
    },
  },
  {
    id: 'R04',
    title: 'S02 returned in full in one note: refunds exactly what was paid',
    working: 'Taxable ₹1,215, IGST ₹218.70, ₹1,433.70 → ₹1,434.00',
    invoiceId: 'S02',
    returned: [{ lineIndex: 0, quantity: 3, previouslyReturnedQuantity: 0 }],
    roundOff: true,
    expected: {
      lines: [{ taxablePaise: 1_215_00, igstPaise: 218_70 }],
      totals: {
        taxablePaise: 1_215_00,
        igstPaise: 218_70,
        roundOffPaise: 30,
        payablePaise: 1_434_00,
      },
    },
  },
];
