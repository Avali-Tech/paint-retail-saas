import {
  schemeClaim,
  schemeProgress,
  type BenefitReceiptView,
  type BrandClaimView,
  type ReceivedBenefit,
  type SchemeDetail,
  type SchemeGrnLineView,
  type SchemeView,
} from '@paint/shared';

// Brand schemes as the API answers them, figured by the real engines (P2-M33).

export const APEX = { id: 'brand-apex', name: 'Apex Paints' };

export const MONSOON: SchemeView = {
  id: 'scheme-monsoon',
  brand: APEX,
  name: 'Monsoon slab',
  brandReference: 'APX/Q2/26',
  startsOn: '2026-07-01',
  endsOn: '2026-09-30',
  measure: 'value',
  mode: 'retro',
  settlementDays: 30,
  dateBasis: 'grn_date',
  status: 'active',
  note: 'Circular of 28 June',
  products: [],
  categories: [{ id: 'cat-emulsions', name: 'Emulsions' }],
  slabs: [
    {
      id: 'slab-1',
      position: 1,
      target: 50_000_00,
      benefits: [
        { kind: 'rebate', basisPoints: 100 },
        { kind: 'points', label: 'Goa trip', points: 1 },
      ],
    },
    {
      id: 'slab-2',
      position: 2,
      target: 1_00_000_00,
      benefits: [
        { kind: 'per_litre', paisePerLitre: 200 },
        {
          kind: 'free_goods',
          variantId: 'v-ult-10',
          units: 1,
          perMillilitres: 100_000,
          variantTitle: 'Apex Paints Ultima 10 l',
        },
        {
          kind: 'free_goods',
          variantId: 'v-ult-20',
          units: 2,
          perMillilitres: null,
          variantTitle: 'Apex Paints Ultima 20 l',
        },
      ],
    },
  ],
  endedAt: null,
  endNote: null,
  createdAt: '2026-07-01T05:00:00.000Z',
  updatedAt: '2026-07-01T05:00:00.000Z',
};

export const LITRES: SchemeView = {
  ...MONSOON,
  id: 'scheme-litres',
  brand: { id: 'brand-berger', name: 'Berger' },
  name: 'Litres club',
  brandReference: null,
  measure: 'litres',
  mode: 'incremental',
  settlementDays: null,
  dateBasis: 'invoice_date',
  status: 'draft',
  note: null,
  categories: [],
  products: [{ id: 'p-silk', name: 'Berger Silk' }],
  slabs: [
    {
      id: 'slab-l1',
      position: 1,
      target: 100_000,
      benefits: [{ kind: 'per_litre', paisePerLitre: 500 }],
    },
  ],
};

const line = (overrides: Partial<SchemeGrnLineView>): SchemeGrnLineView => ({
  kind: 'receipt',
  sourceId: 'grn-1',
  number: 'GRN-000001',
  receivedOn: '2026-07-10',
  supplierInvoiceDate: '2026-07-09',
  countedOn: '2026-07-10',
  store: { id: 'store-hyd', code: 'HYD' },
  supplierName: 'Deccan Distributors',
  variantId: 'v-ult-20',
  sku: 'ULT-20L',
  productName: 'Apex Paints Ultima',
  quantity: 10,
  freeQuantity: 1,
  unitCostPaise: 4_000_00,
  valuePaise: 40_000_00,
  millilitres: 200_000,
  freeMillilitres: 20_000,
  ...overrides,
});

export const GRN_LINES: SchemeGrnLineView[] = [
  line({}),
  line({
    sourceId: 'grn-3',
    number: 'GRN-000003',
    countedOn: '2026-08-05',
    store: { id: 'store-sec', code: 'SEC' },
    variantId: 'v-ult-10',
    sku: 'ULT-10L',
    quantity: 6,
    freeQuantity: 0,
    unitCostPaise: 2_500_00,
    valuePaise: 20_000_00,
    millilitres: 60_000,
    freeMillilitres: 0,
  }),
  line({
    kind: 'return',
    sourceId: 'ledger-1',
    number: 'Damaged tins',
    countedOn: '2026-08-06',
    supplierName: null,
    supplierInvoiceDate: null,
    quantity: -1,
    freeQuantity: 0,
    valuePaise: -4_000_00,
    millilitres: -20_000,
    freeMillilitres: 0,
  }),
];

const receipt = (overrides: Partial<BenefitReceiptView>): BenefitReceiptView => ({
  id: 'rc-1',
  kind: 'money',
  receivedOn: '2026-08-12',
  amountPaise: 400_00,
  moneyForm: 'credit_note',
  variant: null,
  units: null,
  goodsReceipt: null,
  label: null,
  points: null,
  reference: 'CN-881',
  note: null,
  claim: null,
  recordedBy: 'Suma Owner',
  createdAt: '2026-08-12T05:00:00.000Z',
  ...overrides,
});

export const RECEIPTS: BenefitReceiptView[] = [
  receipt({}),
  receipt({
    id: 'rc-2',
    amountPaise: -100_00,
    moneyForm: 'payment',
    reference: null,
    note: 'Brand reduced it',
    claim: { id: 'claim-1', number: 'SC-000001' },
  }),
  receipt({
    id: 'rc-3',
    kind: 'free_goods',
    amountPaise: null,
    moneyForm: null,
    variant: { id: 'v-ult-10', title: 'Apex Paints Ultima 10 l' },
    units: 1,
    reference: null,
  }),
  receipt({
    id: 'rc-4',
    kind: 'points',
    amountPaise: null,
    moneyForm: null,
    label: 'Goa trip',
    points: 1,
  }),
  receipt({
    id: 'rc-5',
    kind: 'free_goods',
    amountPaise: null,
    moneyForm: null,
    variant: { id: 'v-primer', title: 'Apex Paints Primer 1 l' },
    units: 1,
    reference: null,
  }),
];

export const CLAIMS: BrandClaimView[] = [
  {
    id: 'claim-1',
    number: 'SC-000001',
    schemeId: MONSOON.id,
    filedOn: '2026-08-14',
    claimedPaise: 300_00,
    brandReference: 'APX-CLM-77',
    note: null,
    status: 'filed',
    resolvedAt: null,
    resolutionNote: null,
    filedBy: 'Suma Owner',
  },
  {
    id: 'claim-2',
    number: 'SC-000002',
    schemeId: MONSOON.id,
    filedOn: '2026-08-10',
    claimedPaise: 50_00,
    brandReference: null,
    note: 'By phone',
    status: 'acknowledged',
    resolvedAt: null,
    resolutionNote: null,
    filedBy: 'Suma Owner',
  },
  {
    id: 'claim-0',
    number: 'SC-000000',
    schemeId: MONSOON.id,
    filedOn: '2026-08-01',
    claimedPaise: 100_00,
    brandReference: null,
    note: null,
    status: 'withdrawn',
    resolvedAt: '2026-08-02T05:00:00.000Z',
    resolutionNote: null,
    filedBy: 'Suma Owner',
  },
];

/** The engine's view of a scheme. */
export const engineOf = (scheme: SchemeView) => ({
  id: scheme.id,
  brandId: scheme.brand.id,
  startsOn: scheme.startsOn,
  endsOn: scheme.endsOn,
  measure: scheme.measure,
  mode: scheme.mode,
  productIds: scheme.products.map((product) => product.id),
  categoryIds: scheme.categories.map((category) => category.id),
  settlementDays: scheme.settlementDays,
  slabs: scheme.slabs.map((slab) => ({
    id: slab.id,
    target: slab.target,
    benefits: slab.benefits.map((benefit) =>
      benefit.kind === 'free_goods'
        ? {
            kind: 'free_goods' as const,
            variantId: benefit.variantId,
            units: benefit.units,
            perMillilitres: benefit.perMillilitres,
          }
        : benefit,
    ),
  })),
});

/** A scheme's detail as of a day, from its GRN lines and receipts. */
export function schemeDetail(
  scheme: SchemeView,
  asOf: string,
  lines: readonly SchemeGrnLineView[] = GRN_LINES,
  receipts: readonly BenefitReceiptView[] = RECEIPTS,
  claims: readonly BrandClaimView[] = CLAIMS,
): SchemeDetail {
  const engine = engineOf(scheme);
  const progress = schemeProgress(
    engine,
    lines.map((item, index) => ({
      id: String(index),
      brandId: scheme.brand.id,
      productId: 'p',
      categoryId: 'cat-emulsions',
      receivedOn: item.countedOn,
      valuePaise: item.valuePaise,
      millilitres: item.millilitres,
      freeMillilitres: item.freeMillilitres,
    })),
    asOf,
  );
  const received: ReceivedBenefit[] = receipts.map((item) =>
    item.kind === 'money'
      ? {
          kind: 'money',
          id: item.id,
          schemeId: scheme.id,
          receivedOn: item.receivedOn,
          amountPaise: Number(item.amountPaise),
        }
      : item.kind === 'free_goods'
        ? {
            kind: 'free_goods',
            id: item.id,
            schemeId: scheme.id,
            receivedOn: item.receivedOn,
            variantId: String(item.variant?.id),
            units: Number(item.units),
          }
        : {
            kind: 'points',
            id: item.id,
            schemeId: scheme.id,
            receivedOn: item.receivedOn,
            label: String(item.label),
            points: Number(item.points),
          },
  );
  return {
    scheme,
    progress,
    claim: schemeClaim(engine, progress.benefit, received, asOf),
    grnLines: [...lines],
    receipts: [...receipts],
    claims: [...claims],
  };
}
