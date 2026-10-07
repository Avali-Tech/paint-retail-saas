import type { CountLine, StockCount } from '../../api/stock-counts.js';
import type { Challan, Transfer, TransferLine } from '../../api/transfers.js';
import { HYD, PUN } from '../../test-support/inventory-fixtures.js';

// Transfers and stock counts for component tests.

const hyd = { id: HYD.id, code: HYD.code, name: HYD.name };
const pun = { id: PUN.id, code: PUN.code, name: PUN.name };

export const transferLine = (overrides: Partial<TransferLine> = {}): TransferLine => ({
  variantId: 'variant-1l',
  sku: 'APX-1L',
  productName: 'Apex Ultima',
  brandName: 'Asian Paints',
  packSize: 1,
  unit: 'l',
  label: null,
  hsnCode: '3209',
  requestedQuantity: 10,
  approvedQuantity: null,
  dispatchedQuantity: null,
  receivedQuantity: null,
  damagedQuantity: null,
  shortQuantity: null,
  unitCostPaise: null,
  availableAtSource: 12,
  ...overrides,
});

/** HYD sends to PUN. */
export const transfer = (overrides: Partial<Transfer> = {}): Transfer => ({
  id: 'transfer-1',
  number: 'TR-000001',
  status: 'requested',
  from: hyd,
  to: pun,
  note: null,
  closingReason: null,
  requestedAt: '2026-10-01T05:00:00.000Z',
  approvedAt: null,
  dispatchedAt: null,
  receivedAt: null,
  closedAt: null,
  lines: [transferLine()],
  ...overrides,
});

export const inTransit = (overrides: Partial<Transfer> = {}): Transfer =>
  transfer({
    status: 'in_transit',
    approvedAt: '2026-10-01T06:00:00.000Z',
    dispatchedAt: '2026-10-01T07:00:00.000Z',
    lines: [transferLine({ approvedQuantity: 8, dispatchedQuantity: 8, unitCostPaise: 40_000 })],
    ...overrides,
  });

export const CHALLAN: Challan = {
  number: 'TR-000001',
  dispatchedAt: '2026-10-01T07:00:00.000Z',
  from: {
    name: 'Hyderabad',
    code: 'HYD',
    city: 'Hyderabad',
    state: 'Telangana',
    gstin: '36AABCU9603R1ZM',
  },
  to: { name: 'Pune', code: 'PUN', city: null, state: null, gstin: null },
  requiresTaxInvoice: true,
  lines: [
    {
      sku: 'APX-1L',
      description: 'Asian Paints Apex Ultima 1 l',
      hsnCode: '3209',
      quantity: 8,
      unitValuePaise: 40_000,
      valuePaise: 320_000,
    },
    {
      sku: 'APX-4L',
      description: 'Asian Paints Apex Ultima 4 l',
      hsnCode: '3209',
      quantity: 1,
      unitValuePaise: null,
      valuePaise: null,
    },
  ],
  totalValuePaise: 320_000,
};

export const countLine = (overrides: Partial<CountLine> = {}): CountLine => ({
  variantId: 'variant-1l',
  sku: 'APX-1L',
  productName: 'Apex Ultima',
  brandName: 'Asian Paints',
  packSize: 1,
  unit: 'l',
  label: null,
  expectedQuantity: 12,
  countedQuantity: null,
  variance: null,
  varianceValuePaise: null,
  reason: null,
  ...overrides,
});

export const stockCount = (overrides: Partial<StockCount> = {}): StockCount => ({
  id: 'count-1',
  number: 'SC-000001',
  status: 'counting',
  store: hyd,
  scope: 'full',
  scopeId: null,
  note: null,
  closingReason: null,
  startedBy: { memberId: 'member-2', name: 'Ravi Teja' },
  submittedBy: null,
  startedAt: '2026-10-01T05:00:00.000Z',
  submittedAt: null,
  approvedAt: null,
  closedAt: null,
  summary: {
    totalLines: 2,
    countedLines: 0,
    uncountedLines: 2,
    matchingLines: 0,
    accuracyPercent: null,
    netVarianceValuePaise: 0,
    absoluteVarianceValuePaise: 0,
  },
  lines: [countLine(), countLine({ variantId: 'variant-4l', sku: 'APX-4L', expectedQuantity: 3 })],
  ...overrides,
});
