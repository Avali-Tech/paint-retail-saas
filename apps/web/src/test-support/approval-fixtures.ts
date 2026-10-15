import type {
  CreditApprovalDetail,
  CreditApprovalView,
  SaleCreditView,
  SiteAccountDetail,
  SiteAccountView,
} from '@paint/shared';
import { PARTY } from './party-fixtures.js';

// Credit approvals and site accounts as the API answers them (MVP 3, P2-M09), for component tests.

/** §6.3: ₹30,000 limit, ₹18,000 owed, a ₹15,000 order = 110 %. */
export const SALE_CHECK: SaleCreditView = {
  required: true,
  exposureSource: 'ledger',
  position: { status: 'active', limitPaise: 30_000_00, exposurePaise: 18_000_00, overdueDays: 4 },
  check: {
    decision: 'owner_approval',
    blockedBecause: null,
    projectedExposurePaise: 33_000_00,
    availablePaise: -3_000_00,
    utilizationPercent: 110,
  },
  site: null,
  approval: 'owner',
};

export const SALE_APPROVAL: CreditApprovalView = {
  id: '44444444-4444-4444-8444-444444444444',
  number: 'AP-000001',
  kind: 'sale',
  status: 'pending',
  level: 'owner',
  party: { id: PARTY.id, name: 'Apex Builders' },
  site: { projectId: 'project-1', name: 'Jubilee Hills villa' },
  store: { id: 'store-hyd', name: 'Hyderabad' },
  subject: { type: 'sales_order', id: 'order-1', number: 'SO-000017' },
  amountPaise: 15_000_00,
  reason: 'Big site, pays every month',
  checkAtRequest: SALE_CHECK,
  requestedBy: { memberId: 'm2', name: 'Vikram Sales' },
  createdAt: '2026-10-08T06:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  waiveOverdueUntil: null,
  usedAt: null,
  canDecide: true,
};

export const RELEASE_APPROVAL: CreditApprovalView = {
  ...SALE_APPROVAL,
  id: '55555555-5555-4555-8555-555555555555',
  number: 'AP-000002',
  kind: 'release',
  level: null,
  site: null,
  store: null,
  subject: null,
  amountPaise: 0,
  reason: 'Paying this week',
  checkAtRequest: null,
};

export const BILL_APPROVAL: CreditApprovalView = {
  ...SALE_APPROVAL,
  id: '66666666-6666-4666-8666-666666666666',
  number: 'AP-000003',
  status: 'used',
  site: null,
  subject: { type: 'tax_document', id: 'invoice-9', number: 'HYD/26-27/000009' },
  decidedBy: { memberId: 'm1', name: 'Anil Kumar' },
  decidedAt: '2026-10-08T07:00:00.000Z',
  decisionReason: 'Known for years',
  usedAt: '2026-10-08T07:05:00.000Z',
  canDecide: false,
};

export function approvalDetail(
  view: CreditApprovalView,
  checkNow: SaleCreditView | null = null,
): CreditApprovalDetail {
  return { ...view, checkNow };
}

export const SITE: SiteAccountView = {
  id: '77777777-7777-4777-8777-777777777777',
  party: { id: PARTY.id, name: 'Apex Builders' },
  project: { id: 'project-1', number: 'PJ-000001', name: 'Jubilee Hills villa' },
  limitPaise: 10_000_00,
  status: 'active',
  hold: null,
  notes: 'Villa repaint',
  outstandingPaise: 2_000_00,
  openOrdersPaise: 5_000_00,
  exposurePaise: 7_000_00,
  availablePaise: 3_000_00,
  utilizationPercent: 70,
  createdAt: '2026-10-01T06:00:00.000Z',
  updatedAt: '2026-10-01T06:00:00.000Z',
};

export const SITE_DETAIL: SiteAccountDetail = {
  ...SITE,
  ledger: [
    {
      on: '2026-10-02',
      kind: 'invoice',
      documentId: 'invoice-1',
      number: 'HYD/26-27/000001',
      againstNumber: null,
      amountPaise: 3_000_00,
      runningPaise: 3_000_00,
    },
    {
      on: '2026-10-05',
      kind: 'payment',
      documentId: 'invoice-1',
      number: 'RC-000004',
      againstNumber: 'HYD/26-27/000001',
      amountPaise: -1_000_00,
      runningPaise: 2_000_00,
    },
  ],
  openDocuments: [
    {
      documentId: 'invoice-1',
      number: 'HYD/26-27/000001',
      issuedOn: '2026-10-02',
      dueOn: '2026-11-01',
      totalPaise: 3_000_00,
      outstandingPaise: 2_000_00,
      daysPastDue: -21,
      bucket: 'not_due',
    },
  ],
  ageing: { not_due: 2_000_00, d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 },
};
