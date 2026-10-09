import type {
  AccountingExportPreview,
  AccountingExportView,
  LedgerMappingView,
  PaymentModeView,
  PaymentSummary,
  RegisterSessionSummary,
  RegisterSessionView,
} from '@paint/shared';
import type { Store } from '../../api/stock.js';

// Day-end and books data for component tests.

const store = (id: string, code: string, name: string, overrides: Partial<Store> = {}): Store => ({
  id,
  code,
  name,
  type: 'store',
  city: 'Hyderabad',
  state: 'Telangana',
  gstin: null,
  isActive: true,
  ...overrides,
});

export const AMP = store('store-amp', 'AMP', 'Ameerpet');
export const KKP = store('store-kkp', 'KKP', 'Kukatpally');
export const GODOWN = store('store-gdn', 'GDN', 'Godown', { type: 'godown' });
export const CLOSED_STORE = store('store-old', 'OLD', 'Old shop', { isActive: false });
export const STORES = [AMP, KKP, GODOWN, CLOSED_STORE];

/** Opened with ₹2,000, took ₹1,180 cash, refunded ₹100, paid out ₹50: ₹3,030 expected. */
export const OPEN_SESSION: RegisterSessionView = {
  id: 'session-1',
  storeId: AMP.id,
  registerCode: 'COUNTER-1',
  status: 'open',
  openedByMemberId: 'member-1',
  openedBy: 'Anil Kumar',
  openedAt: '2026-10-08T03:30:00.000Z',
  openingFloatPaise: 2_00_000,
  openingNote: 'Morning',
  expectedCashPaise: 3_03_000,
  countedCashPaise: null,
  variancePaise: null,
  denominations: null,
  closedByMemberId: null,
  closedBy: null,
  closedAt: null,
  closingNote: null,
  cashInPaise: 1_18_000,
  cashOutPaise: 10_000,
  movements: [
    {
      id: 'move-1',
      kind: 'pay_out',
      amountPaise: 5_000,
      reason: 'Tea and snacks',
      createdByMemberId: 'member-1',
      createdAt: '2026-10-08T06:00:00.000Z',
    },
  ],
  modeTotals: [
    {
      modeId: 'mode-cash',
      kind: 'cash',
      name: 'Cash',
      inPaise: 1_18_000,
      outPaise: 10_000,
      count: 2,
    },
    { modeId: 'mode-upi', kind: 'upi', name: 'UPI', inPaise: 59_000, outPaise: 0, count: 1 },
  ],
};

/** The demo close: counted ₹3,010 against ₹3,030 expected, ₹20 short. */
export const CLOSED_SESSION: RegisterSessionView = {
  ...OPEN_SESSION,
  status: 'closed',
  countedCashPaise: 3_01_000,
  variancePaise: -2_000,
  denominations: { '50000': 6, '100': 10 },
  closedByMemberId: 'member-1',
  closedBy: 'Anil Kumar',
  closedAt: '2026-10-08T14:30:00.000Z',
  closingNote: 'Short by twenty',
};

export const SUMMARY = (
  overrides: Partial<RegisterSessionSummary> = {},
): RegisterSessionSummary => ({
  id: OPEN_SESSION.id,
  storeId: AMP.id,
  registerCode: 'COUNTER-1',
  status: 'open',
  openedAt: OPEN_SESSION.openedAt,
  closedAt: null,
  openingFloatPaise: 2_00_000,
  variancePaise: null,
  ...overrides,
});

export const PAYMENT = (overrides: Partial<PaymentSummary> = {}): PaymentSummary => ({
  id: 'pay-1',
  number: 'RC-000012',
  voucherNumber: null,
  direction: 'in',
  storeId: AMP.id,
  partyId: 'party-1',
  partyName: 'Deccan Contractors',
  modeKind: 'upi',
  modeName: 'UPI',
  amountPaise: 1_50_000,
  receivedOn: '2026-10-08',
  chequeStatus: null,
  unallocatedPaise: 0,
  ...overrides,
});

export const MODES: PaymentModeView[] = [
  { id: 'mode-cash', kind: 'cash', name: 'Cash', isActive: true },
  { id: 'mode-bank', kind: 'bank_transfer', name: 'Bank transfer', isActive: true },
];

const mapping = (overrides: Partial<LedgerMappingView>): LedgerMappingView => ({
  id: 'map-1',
  purpose: 'sales',
  rateBasisPoints: null,
  nature: null,
  supplyType: null,
  storeId: null,
  modeKind: null,
  modeId: null,
  partyId: null,
  partyName: null,
  ledgerName: 'Sales',
  group: null,
  position: 0,
  updatedAt: '2026-10-08T00:00:00.000Z',
  ...overrides,
});

export const SALES_MAPPING = mapping({
  id: 'map-sales',
  rateBasisPoints: 1800,
  nature: 'taxable',
  supplyType: 'intra_state',
  storeId: AMP.id,
  ledgerName: 'Sales 18% Ameerpet',
});
export const BANK_MAPPING = mapping({
  id: 'map-bank',
  purpose: 'payment_mode',
  modeKind: 'bank_transfer',
  modeId: 'mode-bank',
  ledgerName: 'HDFC Bank',
  group: 'Bank Accounts',
});
export const PARTY_MAPPING = mapping({
  id: 'map-party',
  purpose: 'party',
  partyId: 'party-1',
  partyName: 'Deccan Contractors',
  ledgerName: 'Deccan Contractors (Hyd)',
});
export const ROUND_OFF_MAPPING = mapping({
  id: 'map-round',
  purpose: 'round_off',
  ledgerName: 'Rounding',
});

export const PREVIEW = (
  overrides: Partial<AccountingExportPreview> = {},
): AccountingExportPreview => ({
  from: '2026-10-01',
  to: '2026-10-08',
  companyName: 'ABC Paints Private Limited',
  counts: { sales: 40, credit_note: 3, debit_note: 1, receipt: 15 },
  problems: [],
  manual: { refunds: 0, bouncedCheques: 0 },
  ...overrides,
});

export const EXPORT_ROW = (
  overrides: Partial<AccountingExportView> = {},
): AccountingExportView => ({
  id: 'export-1',
  periodFrom: '2026-09-01',
  periodTo: '2026-09-30',
  kinds: ['sales', 'receipt'],
  format: 'tally_xml',
  documentId: 'doc-1',
  voucherCount: 55,
  createdBy: 'Anil Kumar',
  createdAt: '2026-10-01T05:00:00.000Z',
  ...overrides,
});
