import type {
  InvoiceDispatchesView,
  OrderAvailabilityView,
  OrderCreditView,
  QuotationView,
  SalesLineView,
  SalesOrderLineView,
  SalesOrderView,
  SalesTotalsView,
} from '@paint/shared';
import { PARTY_ID } from '../../test-support/party-fixtures.js';

// Quotations, orders, availability, credit and dispatches as round 4a's API answers
// them, for component tests. One paint and one hardware line: the screens are item-agnostic.

export const STORE_AMP = 'store-amp';
export const STORE_KPH = 'store-kph';

export const salesLine = (overrides: Partial<SalesLineView> = {}): SalesLineView => ({
  id: 'ql-1',
  lineNo: 1,
  variantId: 'v-apex-20',
  sku: 'APX-20L',
  description: 'Asian Paints Apex Ultima 20 l',
  hsnCode: '3209',
  quantity: 2,
  unitPricePaise: 5_000_00,
  discountBps: 1000,
  discountPaise: null,
  taxablePaise: 7_627_12,
  rateBps: 1800,
  cgstPaise: 686_44,
  sgstPaise: 686_44,
  igstPaise: 0,
  cessPaise: 0,
  totalPaise: 9_000_00,
  ...overrides,
});

/** A hinge set (hardware), with a rupee discount. */
export const HINGE_LINE = salesLine({
  id: 'ql-2',
  lineNo: 2,
  variantId: 'v-hinge',
  sku: 'HNG-4',
  description: 'Godrej Hinge 4 inch',
  hsnCode: '8302',
  quantity: 10,
  unitPricePaise: 600_00,
  discountBps: null,
  discountPaise: 0,
  taxablePaise: 5_084_75,
  cgstPaise: 457_63,
  sgstPaise: 457_62,
  totalPaise: 6_000_00,
});

const TOTALS: SalesTotalsView = {
  priceMode: 'inclusive',
  billDiscountBps: null,
  billDiscountPaise: null,
  placeOfSupplyCode: '36',
  supplyType: 'intra_state',
  taxablePaise: 12_711_87,
  cgstPaise: 1_144_07,
  sgstPaise: 1_144_06,
  igstPaise: 0,
  cessPaise: 0,
  roundOffPaise: 0,
  totalPaise: 15_000_00,
};

export const QUOTE: QuotationView = {
  ...TOTALS,
  id: 'quote-1',
  number: 'QT-000042',
  version: 1,
  rootQuotationId: 'quote-1',
  status: 'draft',
  storeId: STORE_AMP,
  billTo: { id: PARTY_ID, name: 'Apex Builders', gstin: '36AABCU9603R1ZO', phone: '9876543210' },
  influencer: { id: 'painter-1', name: 'Ramesh Painter' },
  project: { id: 'project-1', name: 'Madhapur Villa' },
  shipTo: { name: 'Site office', address: 'Plot 12, Madhapur', stateCode: '36' },
  validUntil: '2026-10-22',
  pricedOn: '2026-10-08',
  note: 'Delivery after 5 pm',
  sentAt: null,
  acceptedAt: null,
  salesOrderId: null,
  createdByMemberId: 'member-1',
  createdAt: '2026-10-08T05:00:00.000Z',
  updatedAt: '2026-10-08T05:00:00.000Z',
  lines: [salesLine(), HINGE_LINE],
  versions: [
    { id: 'quote-1', version: 1, status: 'draft', totalPaise: 15_000_00, createdAt: '2026-10-08' },
  ],
};

/** The same quote sent, now with a second version superseding the first. */
export const SENT_QUOTE: QuotationView = {
  ...QUOTE,
  id: 'quote-2',
  version: 2,
  status: 'sent',
  influencer: null,
  project: null,
  shipTo: { name: null, address: null, stateCode: null },
  billTo: { ...QUOTE.billTo, gstin: null, phone: null },
  note: null,
  sentAt: '2026-10-08T06:00:00.000Z',
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 2_288_13,
  lines: [salesLine(), { ...HINGE_LINE, hsnCode: null, rateBps: null }],
  versions: [
    { ...QUOTE.versions[0], id: 'quote-1', status: 'superseded' } as QuotationView['versions'][0],
    { id: 'quote-2', version: 2, status: 'sent', totalPaise: 15_000_00, createdAt: '2026-10-08' },
  ],
};

export const orderLine = (overrides: Partial<SalesOrderLineView> = {}): SalesOrderLineView => ({
  ...salesLine({ id: 'ol-1' }),
  fulfilStoreId: STORE_AMP,
  quantityInvoiced: 0,
  quantityCancelled: 0,
  quantityReserved: 0,
  quantityOpen: 2,
  ...overrides,
});

export const ORDER: SalesOrderView = {
  ...TOTALS,
  id: 'order-1',
  number: 'SO-000017',
  status: 'draft',
  storeId: STORE_AMP,
  paymentTerms: 'postpaid',
  advanceRequiredPaise: null,
  billTo: QUOTE.billTo,
  influencer: QUOTE.influencer,
  project: QUOTE.project,
  shipTo: QUOTE.shipTo,
  quotationId: 'quote-2',
  quotationNumber: 'QT-000042',
  note: null,
  creditCheck: null,
  creditOverride: null,
  confirmedAt: null,
  confirmedByMemberId: null,
  cancelledAt: null,
  cancelReason: null,
  invoicedPaise: 0,
  createdByMemberId: 'member-1',
  createdAt: '2026-10-08T05:00:00.000Z',
  updatedAt: '2026-10-08T05:00:00.000Z',
  lines: [
    orderLine(),
    orderLine({
      ...HINGE_LINE,
      id: 'ol-2',
      fulfilStoreId: STORE_KPH,
      quantityOpen: 10,
    }),
  ],
  reservations: [],
  invoices: [],
};

/** Confirmed, partly billed: the paint fully, 4 of 10 hinges; 1 hinge cancelled. */
export const CONFIRMED: SalesOrderView = {
  ...ORDER,
  status: 'partly_fulfilled',
  quotationId: null,
  quotationNumber: null,
  creditCheck: {
    decision: 'owner_approval',
    blockedBecause: null,
    projectedExposurePaise: 33_000_00,
    availablePaise: -3_000_00,
    utilizationPercent: 110,
  },
  creditOverride: {
    approval: 'owner',
    memberId: 'member-1',
    memberName: 'Anil Kumar',
    reason: 'Pays every month',
    at: '2026-10-08T06:00:00.000Z',
  },
  confirmedAt: '2026-10-08T06:00:00.000Z',
  invoicedPaise: 11_400_00,
  lines: [
    orderLine({ quantityInvoiced: 2, quantityOpen: 0 }),
    orderLine({
      ...HINGE_LINE,
      id: 'ol-2',
      fulfilStoreId: STORE_KPH,
      quantityInvoiced: 4,
      quantityCancelled: 1,
      quantityReserved: 5,
      quantityOpen: 5,
    }),
  ],
  invoices: [
    {
      id: 'invoice-1',
      number: 'AMP/26-27/000001',
      status: 'issued',
      storeId: STORE_AMP,
      issuedOn: '2026-10-08',
      totalPaise: 9_000_00,
    },
    {
      id: 'invoice-2',
      number: null,
      status: 'draft',
      storeId: STORE_KPH,
      issuedOn: null,
      totalPaise: 2_400_00,
    },
  ],
};

/** Spec §7 Round 4 demo: ₹30,000 limit, ₹18,000 owed, a ₹15,000 order = 110 %. */
export const OVER_LIMIT: OrderCreditView = {
  required: true,
  exposureSource: 'ledger',
  position: { status: 'active', limitPaise: 30_000_00, exposurePaise: 18_000_00, overdueDays: 0 },
  check: {
    decision: 'owner_approval',
    blockedBecause: null,
    projectedExposurePaise: 33_000_00,
    availablePaise: -3_000_00,
    utilizationPercent: 110,
  },
  approval: 'owner',
};

export const WITHIN_LIMIT: OrderCreditView = {
  ...OVER_LIMIT,
  exposureSource: 'manual',
  position: { ...OVER_LIMIT.position, exposurePaise: 5_000_00, overdueDays: 3 },
  check: {
    decision: 'allowed',
    blockedBecause: null,
    projectedExposurePaise: 20_000_00,
    availablePaise: 10_000_00,
    utilizationPercent: 66.67,
  },
  approval: 'none',
};

export const NEEDS_MANAGER: OrderCreditView = {
  ...OVER_LIMIT,
  check: { ...OVER_LIMIT.check, decision: 'manager_approval' } as OrderCreditView['check'],
  approval: 'manager',
};

export const BLOCKED: OrderCreditView = {
  ...OVER_LIMIT,
  position: { status: 'on_hold', limitPaise: 0, exposurePaise: 0, overdueDays: 0 },
  check: {
    decision: 'blocked',
    blockedBecause: 'on_hold',
    projectedExposurePaise: 15_000_00,
    availablePaise: -15_000_00,
    utilizationPercent: null,
  },
  approval: 'blocked',
};

export const AVAILABILITY: OrderAvailabilityView = {
  lines: [
    {
      lineId: 'ol-1',
      variantId: 'v-apex-20',
      sku: 'APX-20L',
      fulfilStoreId: STORE_AMP,
      quantityOpen: 2,
      quantityReserved: 0,
      stores: [
        { storeId: STORE_AMP, storeName: 'Ameerpet', onHand: 1, reserved: 0, available: 1 },
        { storeId: STORE_KPH, storeName: 'Kukatpally', onHand: 6, reserved: 2, available: 4 },
      ],
    },
    {
      lineId: 'ol-unknown',
      variantId: 'v-hinge',
      sku: 'HNG-4',
      fulfilStoreId: STORE_KPH,
      quantityOpen: 0,
      quantityReserved: 0,
      stores: [
        { storeId: STORE_KPH, storeName: 'Kukatpally', onHand: 40, reserved: 10, available: 30 },
      ],
    },
  ],
};

export const DISPATCHES: InvoiceDispatchesView = {
  invoiceId: 'invoice-1',
  stockPosting: 'on_dispatch',
  ewayThresholdPaise: 50_000_00,
  lines: [
    {
      invoiceLineId: 'line-1',
      lineNo: 1,
      variantId: 'variant-1',
      description: 'Apex Ultima 1 l',
      quantity: 1,
      dispatchedQuantity: 0,
      pendingQuantity: 1,
    },
    {
      invoiceLineId: 'line-2',
      lineNo: 2,
      variantId: 'variant-2',
      description: null,
      quantity: 2,
      dispatchedQuantity: 1,
      pendingQuantity: 1,
    },
  ],
  dispatches: [
    {
      id: 'dispatch-1',
      number: 'DS-000003',
      invoiceId: 'invoice-1',
      invoiceNumber: 'AMP/26-27/000001',
      storeId: 'store-1',
      dispatchedAt: '2026-10-08T07:00:00.000Z',
      vehicleNo: 'TS09AB1234',
      ewayBillNo: '123456789012',
      ewayValidUntil: '2026-10-09',
      valuePaise: 50_000,
      stockPosted: true,
      note: null,
      createdByMemberId: 'member-1',
      lines: [],
    },
    {
      id: 'dispatch-2',
      number: 'DS-000004',
      invoiceId: 'invoice-1',
      invoiceNumber: 'AMP/26-27/000001',
      storeId: 'store-1',
      dispatchedAt: '2026-10-08T08:00:00.000Z',
      vehicleNo: null,
      ewayBillNo: null,
      ewayValidUntil: null,
      valuePaise: 0,
      stockPosted: true,
      note: null,
      createdByMemberId: 'member-1',
      lines: [],
    },
  ],
};
