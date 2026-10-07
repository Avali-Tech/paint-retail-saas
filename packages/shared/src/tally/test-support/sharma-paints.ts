import { at } from '../../gst/arith.js';
import { computeInvoice, type Invoice } from '../../gst/invoice.js';
import { computeReturn } from '../../gst/returns.js';
import { DEFAULT_GST_OPTIONS, type GstRate } from '../../gst/types.js';
import { gstinCheckCharacter } from '../../tax-ids.js';
import type { TallyLedgerRule } from '../ledgers.js';
import type {
  TallyAllocation,
  TallyParty,
  TallyPaymentMode,
  TallyPeriod,
  TallyReceipt,
  TallySalesDocument,
} from '../types.js';

/**
 * A month (September 2026) of sample documents for the demo business,
 * "Sharma Paints & Hardware": two Telangana stores sharing one GSTIN, local
 * contractors, a walk-in counter, and an Andhra Pradesh builder and home owner
 * for IGST. Every amount comes from the GST engine, so the fixture is what
 * round 2a will store. The golden XML and .xlsx in ../fixtures are built from it.
 */

const gstin = (first14: string) => `${first14}${gstinCheckCharacter(first14)}`;

export const SHARMA_GSTIN = gstin('36AAKFS4821M1Z');

const RATES: GstRate[] = [
  {
    categoryCode: 'std',
    nature: 'taxable',
    rateBasisPoints: 1800,
    cessBasisPoints: 0,
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
  {
    categoryCode: 'exempt',
    nature: 'exempt',
    rateBasisPoints: 0,
    cessBasisPoints: 0,
    effectiveFrom: '2017-07-01',
    effectiveTo: null,
  },
];

interface Product {
  readonly hsn: string;
  /** Shelf price including GST, in paise. B2B is billed at the price before tax. */
  readonly mrp: number;
  readonly category: 'std' | 'exempt';
}

const PRODUCTS = {
  E20: { hsn: '32091090', mrp: 845000, category: 'std' },
  E4: { hsn: '32091090', mrp: 189000, category: 'std' },
  X10: { hsn: '32091010', mrp: 612500, category: 'std' },
  EN1: { hsn: '32081090', mrp: 41500, category: 'std' },
  PT40: { hsn: '32149010', mrp: 98000, category: 'std' },
  PR10: { hsn: '32091090', mrp: 285000, category: 'std' },
  TH1: { hsn: '38140010', mrp: 18500, category: 'std' },
  BR4: { hsn: '96034020', mrp: 21000, category: 'std' },
  RL9: { hsn: '96034020', mrp: 34500, category: 'std' },
  WP5: { hsn: '38249900', mrp: 265000, category: 'std' },
  ST: { hsn: '32129090', mrp: 9500, category: 'std' },
  CAT: { hsn: '49011010', mrp: 5000, category: 'exempt' },
} as const satisfies Record<string, Product>;

type Sku = keyof typeof PRODUCTS;

const party = (
  id: string,
  name: string,
  partyGstin: string | null,
  stateCode: string | null,
): TallyParty => ({ id, name, gstin: partyGstin, stateCode, walkIn: false });

export const PARTIES = {
  walkIn: { id: 'p-walkin', name: 'Cash customer', gstin: null, stateCode: null, walkIn: true },
  sriSai: party('p-srisai', 'Sri Sai Constructions', gstin('36AAMFS7310K1Z'), '36'),
  reddy: party('p-reddy', 'Reddy & Sons Contractors', gstin('36AAJFR2264P1Z'), '36'),
  lakshmi: party('p-lakshmi', 'Lakshmi Interiors', gstin('36ABCPL5521Q1Z'), '36'),
  vijayawada: party('p-vjw', 'Vijayawada Builders Pvt Ltd', gstin('37AADCV8890H1Z'), '37'),
  ravi: party('p-ravi', 'Ravi Kumar (Painter)', null, '36'),
  srinivas: party('p-srinivas', 'Srinivas Rao', null, '37'),
} as const satisfies Record<string, TallyParty>;

type PartyKey = keyof typeof PARTIES;
type Store = 'AMP' | 'KKP';

/** Day of September, store, buyer, lines, and whether it was cancelled. */
type InvoiceSpec = readonly [
  number,
  Store,
  PartyKey,
  readonly (readonly [Sku, number])[],
  boolean?,
];

const INVOICES: readonly InvoiceSpec[] = [
  [
    1,
    'AMP',
    'walkIn',
    [
      ['E4', 1],
      ['BR4', 2],
    ],
  ],
  [
    1,
    'KKP',
    'sriSai',
    [
      ['E20', 4],
      ['PT40', 6],
      ['PR10', 2],
    ],
  ],
  [
    2,
    'AMP',
    'reddy',
    [
      ['X10', 5],
      ['WP5', 2],
    ],
  ],
  [
    2,
    'KKP',
    'walkIn',
    [
      ['EN1', 3],
      ['TH1', 2],
      ['CAT', 1],
    ],
  ],
  [
    3,
    'AMP',
    'vijayawada',
    [
      ['E20', 10],
      ['PR10', 4],
    ],
  ],
  [
    3,
    'AMP',
    'walkIn',
    [
      ['ST', 6],
      ['RL9', 1],
    ],
  ],
  [
    4,
    'KKP',
    'ravi',
    [
      ['E4', 2],
      ['PT40', 1],
    ],
  ],
  [
    4,
    'AMP',
    'lakshmi',
    [
      ['E20', 2],
      ['E4', 3],
    ],
  ],
  [5, 'KKP', 'walkIn', [['WP5', 1]]],
  [5, 'AMP', 'lakshmi', [['EN1', 4]], true],
  [
    7,
    'AMP',
    'sriSai',
    [
      ['X10', 3],
      ['ST', 12],
    ],
  ],
  [
    7,
    'KKP',
    'walkIn',
    [
      ['E4', 1],
      ['RL9', 2],
      ['BR4', 1],
    ],
  ],
  [
    8,
    'AMP',
    'srinivas',
    [
      ['E20', 1],
      ['PR10', 1],
      ['CAT', 2],
    ],
  ],
  [
    8,
    'KKP',
    'reddy',
    [
      ['PT40', 20],
      ['PR10', 3],
    ],
  ],
  [
    9,
    'AMP',
    'walkIn',
    [
      ['TH1', 4],
      ['EN1', 2],
    ],
  ],
  [
    10,
    'KKP',
    'lakshmi',
    [
      ['E20', 3],
      ['X10', 2],
    ],
  ],
  [10, 'AMP', 'walkIn', [['E4', 2]]],
  [
    11,
    'AMP',
    'vijayawada',
    [
      ['WP5', 6],
      ['X10', 4],
    ],
  ],
  [
    12,
    'KKP',
    'ravi',
    [
      ['E20', 1],
      ['BR4', 3],
      ['CAT', 1],
    ],
  ],
  [
    12,
    'AMP',
    'walkIn',
    [
      ['PT40', 2],
      ['ST', 3],
    ],
  ],
  [
    14,
    'AMP',
    'reddy',
    [
      ['E20', 6],
      ['E4', 4],
      ['RL9', 4],
    ],
  ],
  [14, 'KKP', 'walkIn', [['X10', 1]]],
  [
    15,
    'KKP',
    'sriSai',
    [
      ['WP5', 3],
      ['TH1', 6],
    ],
  ],
  [
    16,
    'AMP',
    'walkIn',
    [
      ['EN1', 1],
      ['BR4', 1],
    ],
  ],
  [
    17,
    'AMP',
    'lakshmi',
    [
      ['PR10', 5],
      ['PT40', 8],
    ],
  ],
  [
    17,
    'KKP',
    'walkIn',
    [
      ['E4', 3],
      ['ST', 4],
    ],
  ],
  [18, 'KKP', 'reddy', [['X10', 6]]],
  [
    19,
    'AMP',
    'walkIn',
    [
      ['RL9', 2],
      ['TH1', 1],
    ],
  ],
  [
    19,
    'AMP',
    'ravi',
    [
      ['E4', 4],
      ['PT40', 2],
    ],
  ],
  [
    21,
    'KKP',
    'vijayawada',
    [
      ['E20', 8],
      ['WP5', 2],
    ],
  ],
  [21, 'AMP', 'walkIn', [['E20', 1]]],
  [
    22,
    'AMP',
    'sriSai',
    [
      ['E20', 5],
      ['PR10', 3],
      ['ST', 10],
    ],
  ],
  [
    23,
    'KKP',
    'walkIn',
    [
      ['EN1', 2],
      ['CAT', 1],
    ],
  ],
  [
    24,
    'KKP',
    'lakshmi',
    [
      ['X10', 2],
      ['BR4', 6],
    ],
  ],
  [
    25,
    'AMP',
    'walkIn',
    [
      ['WP5', 1],
      ['RL9', 1],
    ],
  ],
  [26, 'AMP', 'reddy', [['PT40', 15]]],
  [
    26,
    'KKP',
    'walkIn',
    [
      ['E4', 1],
      ['TH1', 2],
    ],
  ],
  [
    28,
    'KKP',
    'sriSai',
    [
      ['X10', 4],
      ['E4', 2],
    ],
  ],
  [
    29,
    'AMP',
    'walkIn',
    [
      ['ST', 8],
      ['BR4', 2],
    ],
  ],
  [
    30,
    'AMP',
    'ravi',
    [
      ['E20', 2],
      ['RL9', 2],
    ],
  ],
];

const iso = (day: number) => `2026-09-${String(day).padStart(2, '0')}`;
const fy = '26-27';

/** B2B prices are the shelf price before GST (MRP × 100 / 118, to the paisa). */
const tradePrice = (mrp: number) => Math.round((mrp * 100) / 118);

interface Issued {
  readonly doc: TallySalesDocument;
  readonly invoice: Invoice;
  readonly skus: readonly Sku[];
}

function toDocument(
  invoice: Invoice,
  skus: readonly Sku[],
  header: Omit<
    TallySalesDocument,
    | 'lines'
    | 'roundOffPaise'
    | 'totalPaise'
    | 'placeOfSupplyCode'
    | 'supplyType'
    | 'supplierGstin'
    | 'supplierStateCode'
  >,
  lines: Invoice['lines'] | ReturnType<typeof computeReturn>['lines'],
  totals: Invoice['totals'] | ReturnType<typeof computeReturn>['totals'],
): TallySalesDocument {
  return {
    ...header,
    supplierGstin: SHARMA_GSTIN,
    supplierStateCode: '36',
    placeOfSupplyCode: invoice.placeOfSupply,
    supplyType: invoice.supplyType,
    lines: lines.map((line, index) => {
      const sku = at(skus, 'lineIndex' in line ? line.lineIndex : index);
      return {
        hsnCode: PRODUCTS[sku].hsn,
        nature: line.rate?.nature ?? 'taxable',
        rateBasisPoints: line.rate?.rateBasisPoints ?? 0,
        cessBasisPoints: line.rate?.cessBasisPoints ?? 0,
        taxablePaise: line.taxablePaise,
        cgstPaise: line.cgstPaise,
        sgstPaise: line.sgstPaise,
        igstPaise: line.igstPaise,
        cessPaise: line.cessPaise,
      };
    }),
    roundOffPaise: totals.roundOffPaise,
    totalPaise: totals.payablePaise,
  };
}

function issueInvoices(): Issued[] {
  const next: Record<Store, number> = { AMP: 412, KKP: 233 };
  return INVOICES.map(([day, store, key, items, cancelled = false], index) => {
    const buyer = PARTIES[key];
    const b2c = buyer.gstin === null;
    const invoice = computeInvoice({
      invoiceDate: iso(day),
      registration: 'regular',
      parties: {
        supplierStateCode: '36',
        buyerGstin: buyer.gstin,
        // A named B2C buyer outside Telangana has the goods delivered there.
        deliveryStateCode: b2c && buyer.stateCode !== '36' ? buyer.stateCode : null,
        storeStateCode: '36',
      },
      pricesIncludeTax: b2c,
      lines: items.map(([sku, quantity]) => ({
        categoryCode: PRODUCTS[sku].category,
        quantity,
        unitPricePaise: b2c ? PRODUCTS[sku].mrp : tradePrice(PRODUCTS[sku].mrp),
        discount: null,
      })),
      invoiceDiscount: null,
      rates: RATES,
      options: DEFAULT_GST_OPTIONS,
    });
    const number = `${store}/${fy}/${String(next[store]++).padStart(6, '0')}`;
    const skus = items.map(([sku]) => sku);
    const doc = toDocument(
      invoice,
      skus,
      {
        id: `inv-${String(index + 1).padStart(3, '0')}`,
        kind: 'tax_invoice',
        number,
        issuedOn: iso(day),
        cancelled,
        storeCode: store,
        party: buyer,
        originals: [],
        allocations: [],
        note: cancelled ? 'Billed to the wrong customer at the counter' : null,
      },
      invoice.lines,
      invoice.totals,
    );
    return { doc, invoice, skus };
  });
}

function notes(issued: readonly Issued[]): TallySalesDocument[] {
  const find = (number: string) => {
    const found = issued.find(({ doc }) => doc.number === number);
    if (!found) throw new Error(`No invoice ${number}`);
    return found;
  };
  const credit = (
    id: string,
    number: string,
    day: number,
    of: string,
    returned: readonly (readonly [number, number])[],
    allocate: boolean,
    note: string,
  ): TallySalesDocument => {
    const source = find(of);
    const result = computeReturn(
      source.invoice,
      returned.map(([lineIndex, quantity]) => ({
        lineIndex,
        quantity,
        previouslyReturnedQuantity: 0,
      })),
      true,
    );
    const allocations: TallyAllocation[] = allocate
      ? [{ documentNumber: of, amountPaise: result.totals.payablePaise }]
      : [];
    return toDocument(
      source.invoice,
      source.skus,
      {
        id,
        kind: 'credit_note',
        number,
        issuedOn: iso(day),
        cancelled: false,
        storeCode: source.doc.storeCode,
        party: source.doc.party,
        originals: [{ number: of, issuedOn: source.doc.issuedOn }],
        allocations,
        note,
      },
      result.lines,
      result.totals,
    );
  };

  // Debit note: Reddy & Sons were billed putty at ₹50 a bag too little on AMP/26-27/000432.
  const undercharged = find('AMP/26-27/000432');
  const difference = computeInvoice({
    invoiceDate: iso(27),
    registration: 'regular',
    parties: {
      supplierStateCode: '36',
      buyerGstin: PARTIES.reddy.gstin,
      deliveryStateCode: null,
      storeStateCode: '36',
    },
    pricesIncludeTax: false,
    lines: [{ categoryCode: 'std', quantity: 15, unitPricePaise: 5000, discount: null }],
    invoiceDiscount: null,
    rates: RATES,
    options: DEFAULT_GST_OPTIONS,
  });
  const debit = toDocument(
    difference,
    ['PT40'],
    {
      id: 'dn-001',
      kind: 'debit_note',
      number: `AMPD/${fy}/00001`,
      issuedOn: iso(27),
      cancelled: false,
      storeCode: 'AMP',
      party: PARTIES.reddy,
      originals: [{ number: undercharged.doc.number, issuedOn: undercharged.doc.issuedOn }],
      allocations: [],
      note: 'Price difference: wall putty billed at the old rate',
    },
    difference.lines,
    difference.totals,
  );

  return [
    // Sri Sai send back the whole of their 15 September order: the note mirrors the invoice.
    credit(
      'cn-001',
      `KKPC/${fy}/00001`,
      18,
      'KKP/26-27/000242',
      [
        [0, 3],
        [1, 6],
      ],
      true,
      'Return: full order',
    ),
    // A walk-in returns one 4 L emulsion from 7 September.
    credit(
      'cn-002',
      `KKPC/${fy}/00002`,
      9,
      'KKP/26-27/000237',
      [[0, 1]],
      false,
      'Return: wrong shade',
    ),
    // Vijayawada Builders return two damaged waterproofing cans (IGST).
    credit(
      'cn-003',
      `AMPC/${fy}/00001`,
      20,
      'AMP/26-27/000422',
      [[0, 2]],
      true,
      'Return: damaged in transit',
    ),
    debit,
  ];
}

const MODES = {
  cash: { kind: 'cash', name: 'Cash' },
  upi: { kind: 'upi', name: 'UPI' },
  cheque: { kind: 'cheque', name: 'Cheque' },
  neft: { kind: 'bank_transfer', name: 'NEFT / RTGS' },
} as const satisfies Record<string, TallyPaymentMode>;

function receipts(issued: readonly Issued[]): TallyReceipt[] {
  const byNumber = (number: string) => {
    const found = issued.find(({ doc }) => doc.number === number);
    if (!found) throw new Error(`No invoice ${number}`);
    return found.doc;
  };
  let seq = 871;
  let count = 0;
  const receipt = (
    day: number,
    store: Store,
    key: PartyKey,
    mode: keyof typeof MODES,
    amountPaise: number,
    allocations: readonly TallyAllocation[],
    reference: string | null,
    advance = false,
  ): TallyReceipt => {
    const number = advance ? `${store}A/${fy}/00001` : `RC-${String(seq++).padStart(6, '0')}`;
    return {
      id: `rc-${String(++count).padStart(3, '0')}`,
      number,
      receivedOn: iso(day),
      storeCode: store,
      party: PARTIES[key],
      mode: MODES[mode],
      amountPaise,
      reference,
      advance,
      allocations,
      note: null,
    };
  };
  /** A walk-in pays the whole bill at the counter. */
  const counter = (number: string, mode: keyof typeof MODES, reference: string | null) => {
    const doc = byNumber(number);
    const day = Number(doc.issuedOn.slice(8));
    return receipt(day, doc.storeCode as Store, 'walkIn', mode, doc.totalPaise, [], reference);
  };
  const full = (number: string) => ({
    documentNumber: number,
    amountPaise: byNumber(number).totalPaise,
  });
  /** Settles the first bill in full and puts the rest of `amount` against the second. */
  const split = (amount: number, first: string, second: string): TallyAllocation[] => [
    full(first),
    { documentNumber: second, amountPaise: amount - byNumber(first).totalPaise },
  ];
  return [
    counter('AMP/26-27/000412', 'cash', null),
    counter('KKP/26-27/000234', 'upi', 'UTR 624511873301'),
    counter('AMP/26-27/000415', 'cash', null),
    counter('KKP/26-27/000236', 'cash', null),
    counter('KKP/26-27/000237', 'upi', 'UTR 625013370012'),
    counter('AMP/26-27/000420', 'cash', null),
    counter('AMP/26-27/000421', 'upi', 'UTR 625318841290'),
    // Sri Sai pay a round ₹50,000: their first bill in full, the rest on account.
    receipt(
      6,
      'KKP',
      'sriSai',
      'cheque',
      5000000,
      [full('KKP/26-27/000233')],
      'Cheque 004512, SBI',
    ),
    receipt(
      9,
      'AMP',
      'reddy',
      'neft',
      byNumber('AMP/26-27/000413').totalPaise,
      [full('AMP/26-27/000413')],
      'NEFT UTIB26252009871',
    ),
    receipt(13, 'AMP', 'lakshmi', 'upi', 2500000, [], 'UTR 625611009187', true),
    receipt(
      15,
      'AMP',
      'vijayawada',
      'cheque',
      10000000,
      [full('AMP/26-27/000414')],
      'Cheque 118870, Andhra Bank',
    ),
    receipt(
      16,
      'KKP',
      'ravi',
      'cash',
      300000,
      [{ documentNumber: 'KKP/26-27/000235', amountPaise: 300000 }],
      null,
    ),
    receipt(
      20,
      'KKP',
      'reddy',
      'upi',
      4000000,
      split(4000000, 'KKP/26-27/000238', 'AMP/26-27/000424'),
      'UTR 626314420077',
    ),
    receipt(
      25,
      'AMP',
      'srinivas',
      'upi',
      byNumber('AMP/26-27/000419').totalPaise,
      [full('AMP/26-27/000419')],
      'UTR 626819923411',
    ),
    receipt(
      29,
      'KKP',
      'lakshmi',
      'cheque',
      6000000,
      split(6000000, 'AMP/26-27/000416', 'KKP/26-27/000239'),
      'Cheque 220061, HDFC Bank',
    ),
  ];
}

/** The September 2026 period for Sharma Paints & Hardware. */
export function sharmaPaintsSeptember(): TallyPeriod {
  const issued = issueInvoices();
  return {
    companyName: 'Sharma Paints & Hardware',
    from: '2026-09-01',
    to: '2026-09-30',
    documents: [...issued.map(({ doc }) => doc), ...notes(issued)],
    receipts: receipts(issued),
  };
}

/** Sharma's mapping: its bank, and a separate cash box at Kukatpally. Everything else is default. */
export const SHARMA_LEDGER_RULES: readonly TallyLedgerRule[] = [
  { purpose: 'payment_mode', modeKind: 'bank_transfer', ledgerName: 'HDFC Bank' },
  { purpose: 'payment_mode', modeKind: 'cash', storeCode: 'KKP', ledgerName: 'Cash - Kukatpally' },
];
