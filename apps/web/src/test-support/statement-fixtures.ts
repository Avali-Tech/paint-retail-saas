import type {
  BrandStatementDetail,
  BrandStatementSummaryView,
  OurRecordView,
  StatementLineView,
  StatementPreview,
  StatementTemplateView,
} from '@paint/shared';

// Brand statements (P2-M34) as the API answers them, for the screens' tests.

export const TEMPLATE: StatementTemplateView = {
  id: 'tpl-deccan',
  name: 'Deccan ledger',
  supplierPartyId: 'sup-deccan',
  brandId: 'brand-apex',
  headerRowsToSkip: 1,
  dateColumn: 'Date',
  documentColumn: 'Doc No',
  typeColumn: 'Type',
  referenceColumn: null,
  descriptionColumn: 'Narration',
  amountMode: 'debit_credit',
  debitColumn: 'Debit',
  creditColumn: 'Credit',
  amountColumn: null,
  signConvention: 'debit_positive',
  dateFormat: 'dd-mm-yyyy',
  typeRules: { credit_note: ['Credit Note'], payment: ['Receipt'] },
  dateWindowDays: 7,
  amountTolerancePaise: 100,
  grnAmountBasis: 'with_gst',
  isActive: true,
  supplier: { id: 'sup-deccan', name: 'Deccan Distributors' },
  brand: { id: 'brand-apex', name: 'Apex Paints' },
  statements: 1,
  updatedAt: '2026-10-01T05:00:00.000Z',
};

export const SIGNED_TEMPLATE: StatementTemplateView = {
  ...TEMPLATE,
  id: 'tpl-plain',
  name: 'Plain ledger',
  supplierPartyId: 'sup-plain',
  brandId: null,
  typeColumn: null,
  descriptionColumn: null,
  amountMode: 'signed',
  debitColumn: null,
  creditColumn: null,
  amountColumn: 'Amount',
  typeRules: {},
  isActive: false,
  supplier: { id: 'sup-plain', name: 'Plain Distributors' },
  brand: null,
  statements: 0,
};

export const SUMMARY: BrandStatementSummaryView = {
  id: 'bs-1',
  number: 'BS-000001',
  template: { id: TEMPLATE.id, name: TEMPLATE.name },
  supplier: TEMPLATE.supplier,
  brand: TEMPLATE.brand,
  periodFrom: '2026-07-01',
  periodTo: '2026-07-31',
  status: 'active',
  fileName: 'July.csv',
  fileKept: true,
  lines: 7,
  mismatches: 3,
  uploadedBy: 'Suma Owner',
  createdAt: '2026-08-02T05:00:00.000Z',
  matchedAt: '2026-08-02T05:00:00.000Z',
};

const line = (
  id: string,
  rowNumber: number,
  values: Partial<StatementLineView>,
): StatementLineView => ({
  id,
  rowNumber,
  lineDate: '2026-07-09',
  kind: 'invoice',
  documentNumber: `AD/${String(100 + rowNumber)}`,
  typeText: 'Invoice',
  reference: null,
  description: null,
  amountPaise: 40_000_00,
  status: 'unmatched',
  match: null,
  rejected: [],
  ...values,
});

export const LINES: StatementLineView[] = [
  line('l-open', 3, { kind: 'opening', documentNumber: null, amountPaise: 10_000_00 }),
  line('l-auto', 4, {
    status: 'matched',
    description: 'Ultima 20 L',
    match: { source: 'auto', recordKey: 'grn:g1', differencePaise: 0, note: null, by: null },
  }),
  line('l-partial', 5, {
    lineDate: '2026-07-15',
    amountPaise: 5_250_00,
    status: 'partial',
    match: {
      source: 'manual',
      recordKey: 'grn:g2',
      differencePaise: 250_00,
      note: 'Freight added',
      by: 'Suma Owner',
    },
  }),
  line('l-missing', 6, { lineDate: '2026-07-22', amountPaise: 7_000_00, documentNumber: null }),
  line('l-cn', 7, {
    lineDate: '2026-07-28',
    kind: 'credit_note',
    documentNumber: 'CN/7790',
    amountPaise: -800_00,
  }),
  line('l-pay', 8, {
    lineDate: '2026-07-30',
    kind: 'payment',
    amountPaise: -50_000_00,
    status: 'untracked',
  }),
  line('l-explained', 9, {
    kind: 'other',
    amountPaise: -100_00,
    status: 'explained',
    match: {
      source: 'explained',
      recordKey: null,
      differencePaise: null,
      note: 'Rounding',
      by: 'Suma Owner',
    },
  }),
];

const record = (key: string, values: Partial<OurRecordView>): OurRecordView => {
  const [kind, id] = key.split(':') as [OurRecordView['kind'], string];
  return {
    key,
    kind,
    id,
    number: 'GRN-000001',
    reference: 'AD/104',
    date: '2026-07-09',
    amountPaise: 40_000_00,
    inPeriod: true,
    lineId: null,
    elsewhere: false,
    schemeId: null,
    ...values,
  };
};

export const OURS: OurRecordView[] = [
  record('grn:g1', { lineId: 'l-auto' }),
  record('grn:g2', {
    number: 'GRN-000002',
    reference: 'AD/105',
    amountPaise: 5_000_00,
    lineId: 'l-partial',
  }),
  record('grn:g3', { number: 'GRN-000003', reference: 'AD/150', amountPaise: 2_000_00 }),
  record('grn:g4', { number: 'GRN-000004', reference: null, inPeriod: false }),
  record('grn:g5', { number: 'GRN-000005', elsewhere: true }),
  record('benefit_receipt:r1', {
    number: 'Monsoon slab',
    reference: 'CN-7781',
    amountPaise: -1_200_00,
    schemeId: 'scheme-1',
  }),
];

export const DETAIL: BrandStatementDetail = {
  statement: SUMMARY,
  tolerance: { dateWindowDays: 7, amountTolerancePaise: 100 },
  summary: {
    counts: { matched: 1, partial: 1, unmatched: 2, explained: 1, untracked: 1 },
    brandMovementPaise: 1_350_00,
    ourMovementPaise: 46_200_00,
    differencePaise: -44_850_00,
    amountDifferencesPaise: 250_00,
    unmatchedLinesPaise: 6_200_00,
    explainedLinesPaise: -100_00,
    untrackedLinesPaise: -50_000_00,
    ourUnmatchedPaise: 1_200_00,
    ourUnmatchedCount: 2,
    openingBalancePaise: 10_000_00,
    brandClosingPaise: 11_350_00,
    printedClosingPaise: 12_000_00,
  },
  lines: LINES,
  ours: OURS,
};

export const PREVIEW: StatementPreview = {
  fileName: 'July.csv',
  valid: true,
  lines: LINES.map(
    ({
      rowNumber,
      lineDate,
      kind,
      documentNumber,
      typeText,
      reference,
      description,
      amountPaise,
    }) => ({
      rowNumber,
      lineDate,
      kind,
      documentNumber,
      typeText,
      reference,
      description,
      amountPaise,
    }),
  ),
  errors: [],
  skipped: [{ row: 11, column: null, message: 'Total 77,250.00' }],
  periodFrom: '2026-07-01',
  periodTo: '2026-07-30',
  openingBalancePaise: 10_000_00,
  debitsPaise: 67_250_00,
  creditsPaise: 52_000_00,
  duplicateOf: null,
};
