import type { CreditRequest, CreditSummary } from '../api/credit.js';
import type { LedgerEntry, LoyaltySettings, LoyaltySummary, LoyaltyView } from '../api/loyalty.js';
import type { Party, PartyOverview } from '../api/parties.js';

// Customers, credit and loyalty as the API answers them, for component tests.

export const PARTY_ID = '11111111-1111-4111-8111-111111111111';

/** A customer with every detail filled in. */
export const PARTY: Party = {
  id: PARTY_ID,
  kind: 'organization',
  displayName: 'Apex Builders',
  legalName: 'Apex Builders Private Limited',
  contactPerson: 'Ravi Teja',
  phone: '+919876543210',
  alternatePhone: '+919812345678',
  email: 'accounts@apex.in',
  gstin: '36AABCU9603R1ZO',
  pan: 'AABCU9603R',
  addressLine: 'Plot 12, Madhapur',
  city: 'Hyderabad',
  state: 'Telangana',
  pincode: '500081',
  homeStoreId: 'store-hyd',
  notes: 'Pays on time',
  tags: ['builder', 'vip'],
  isActive: true,
  roles: ['customer', 'contractor'],
  customer: { customerType: 'builder', assignedMemberId: null, preferredContact: 'whatsapp' },
};

/** A walk-in customer with only a name. */
export const BARE_PARTY: Party = {
  ...PARTY,
  id: '22222222-2222-4222-8222-222222222222',
  kind: 'person',
  displayName: 'Walk-in Ramesh',
  legalName: null,
  contactPerson: null,
  phone: null,
  alternatePhone: null,
  email: null,
  gstin: null,
  pan: null,
  addressLine: null,
  city: null,
  state: null,
  pincode: null,
  homeStoreId: null,
  notes: null,
  tags: [],
  isActive: false,
  roles: ['painter'],
  customer: null,
};

export const STORES = [
  { id: 'store-hyd', code: 'HYD', name: 'Hyderabad' },
  { id: 'store-pun', code: 'PUN', name: 'Pune' },
];

export const CREDIT: CreditSummary = {
  status: 'active',
  limitPaise: 50_000_00,
  creditDays: 30,
  risk: 'medium',
  manualExposurePaise: 10_000_00,
  overdueDays: 0,
  check: {
    decision: 'allowed',
    blockedBecause: null,
    projectedExposurePaise: 10_000_00,
    availablePaise: 40_000_00,
    utilizationPercent: 20,
  },
  pendingRequest: null,
};

export const NO_CREDIT: CreditSummary = {
  status: 'none',
  limitPaise: 0,
  creditDays: 0,
  risk: 'low',
  manualExposurePaise: 0,
  overdueDays: 0,
  check: {
    decision: 'blocked',
    blockedBecause: 'no_credit',
    projectedExposurePaise: 0,
    availablePaise: 0,
    utilizationPercent: null,
  },
  pendingRequest: null,
};

export const LOYALTY: LoyaltySummary = {
  account: {
    id: 'acct-1',
    status: 'active',
    assignedTo: { memberId: 'm1', name: 'Sunita Rao' },
    createdAt: '2026-09-01T05:00:00.000Z',
  },
  balance: 1200,
  totalEarned: 1500,
  totalRedeemed: 300,
  tier: { name: 'Silver', minPoints: 1000 },
  nextTier: { name: 'Gold', minPoints: 5000, pointsToGo: 3500 },
  nextExpiry: { points: 200, expiresOn: '2027-03-31' },
};

export const NOT_ENROLLED: LoyaltySummary = {
  account: null,
  balance: 0,
  totalEarned: 0,
  totalRedeemed: 0,
  tier: null,
  nextTier: null,
  nextExpiry: null,
};

export const LEDGER: LedgerEntry[] = [
  {
    id: 'l3',
    kind: 'redeem',
    points: -300,
    manualPurchasePaise: null,
    reference: null,
    note: 'Gift voucher',
    expiresOn: null,
    createdBy: { memberId: 'm1', name: 'Sunita Rao' },
    createdAt: '2026-09-20T06:00:00.000Z',
  },
  {
    id: 'l2',
    kind: 'purchase',
    points: 1500,
    manualPurchasePaise: 1_50_000_00,
    reference: 'INV-104',
    note: null,
    expiresOn: '2027-03-31',
    createdBy: { memberId: 'm1', name: 'Sunita Rao' },
    createdAt: '2026-09-10T06:00:00.000Z',
  },
  {
    id: 'l1',
    kind: 'expire',
    points: 0,
    manualPurchasePaise: null,
    reference: null,
    note: null,
    expiresOn: null,
    createdBy: null,
    createdAt: '2026-09-01T06:00:00.000Z',
  },
];

export function loyaltyView(entries: LedgerEntry[] = LEDGER, total = entries.length): LoyaltyView {
  return {
    ...LOYALTY,
    party: { id: PARTY_ID, name: PARTY.displayName },
    ledger: { items: entries, total },
  };
}

/** The customer 360 with every section the owner can see, all filled in. */
export const OVERVIEW: PartyOverview = {
  party: PARTY,
  leads: {
    total: 12,
    open: 2,
    items: [
      {
        id: 'lead-1',
        number: 'LD-000001',
        title: 'Villa repaint',
        stage: 'qualified',
        storeCode: 'HYD',
        estimatedValuePaise: 2_00_000_00,
        updatedAt: '2026-09-20T06:00:00.000Z',
      },
      {
        id: 'lead-2',
        number: 'LD-000002',
        title: 'Office touch-up',
        stage: 'new',
        storeCode: 'HYD',
        estimatedValuePaise: null,
        updatedAt: '2026-09-21T06:00:00.000Z',
      },
    ],
  },
  opportunities: {
    total: 1,
    openValuePaise: 5_00_000_00,
    wonValuePaise: 1_00_000_00,
    items: [
      {
        id: 'opp-1',
        number: 'OP-000001',
        title: 'Tower B exterior',
        stage: 'proposal',
        storeCode: 'HYD',
        expectedValuePaise: 5_00_000_00,
        probability: 40,
        updatedAt: '2026-09-22T06:00:00.000Z',
      },
    ],
  },
  projects: {
    total: 1,
    items: [
      {
        id: 'prj-1',
        number: 'PR-000001',
        name: 'Lake View Towers',
        stage: 'execution',
        storeCode: 'HYD',
        city: 'Hyderabad',
        roles: ['contractor'],
        updatedAt: '2026-09-23T06:00:00.000Z',
      },
      {
        id: 'prj-2',
        number: 'PR-000002',
        name: 'Green Homes',
        stage: 'survey',
        storeCode: 'PUN',
        city: null,
        roles: ['customer'],
        updatedAt: '2026-09-24T06:00:00.000Z',
      },
    ],
  },
  contracts: {
    total: 2,
    active: 1,
    renewalDue: 1,
    items: [
      {
        id: 'ct-1',
        number: 'CT-000001',
        title: 'Annual rate contract',
        type: 'contractor_agreement',
        status: 'active',
        startDate: '2025-10-01',
        endDate: '2026-10-31',
        renewalDate: '2026-10-01',
        renewalDue: true,
        valuePaise: 10_00_000_00,
      },
      {
        id: 'ct-2',
        number: 'CT-000002',
        title: 'Old agreement',
        type: 'other',
        status: 'expired',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        renewalDate: '2024-12-01',
        renewalDue: false,
        valuePaise: null,
      },
    ],
  },
  credit: CREDIT,
  loyalty: LOYALTY,
  activities: {
    total: 1,
    items: [
      {
        id: 'act-1',
        type: 'visit',
        subject: 'Site visit',
        status: 'done',
        record: { type: 'party', id: PARTY_ID, label: 'Apex Builders' },
        at: '2026-09-25T06:00:00.000Z',
      },
    ],
    nextFollowUp: {
      id: 'act-2',
      subject: 'Call about the quote',
      dueAt: '2026-10-05T05:30:00.000Z',
      label: 'Apex Builders',
    },
  },
  documents: {
    total: 1,
    items: [
      {
        id: 'doc-1',
        category: 'gst_certificate',
        fileName: 'gst.pdf',
        note: null,
        createdAt: '2026-09-02T06:00:00.000Z',
      },
    ],
  },
};

/** What a member without CRM, credit or loyalty access sees of a party with nothing linked. */
export const BARE_OVERVIEW: PartyOverview = {
  party: BARE_PARTY,
  leads: null,
  opportunities: null,
  projects: null,
  contracts: null,
  credit: null,
  loyalty: null,
  activities: { total: 0, items: [], nextFollowUp: null },
  documents: { total: 0, items: [] },
};

export const CREDIT_REQUEST: CreditRequest = {
  id: '33333333-3333-4333-8333-333333333333',
  number: 'CR-000001',
  party: { id: PARTY_ID, name: 'Apex Builders' },
  limitPaise: 1_00_000_00,
  creditDays: 45,
  previousLimitPaise: 50_000_00,
  previousCreditDays: 30,
  note: 'Big order coming',
  status: 'pending',
  requestedBy: { memberId: 'm2', name: 'Vikram Sales' },
  createdAt: '2026-09-28T06:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
};

export const DECIDED_REQUEST: CreditRequest = {
  ...CREDIT_REQUEST,
  id: '44444444-4444-4444-8444-444444444444',
  number: 'CR-000002',
  status: 'approved',
  note: null,
  decidedBy: { memberId: 'm0', name: 'Anil Kumar' },
  decidedAt: '2026-09-29T06:00:00.000Z',
  decisionNote: 'Good payer',
};

export const LOYALTY_SETTINGS: LoyaltySettings = {
  earnPoints: 1,
  earnPerPaise: 10_000,
  tiers: [
    { name: 'Silver', minPoints: 1000 },
    { name: 'Gold', minPoints: 5000 },
  ],
  expiryDays: 365,
  minRedemptionPoints: 100,
};
