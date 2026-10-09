import type {
  IssuedInvoiceView,
  PaymentModeView,
  TaxCategoryOptions,
  TaxDocumentLineView,
  TaxDocumentView,
} from '@paint/shared';
import type { Store } from '../../api/stock.js';
import { profile } from '../../test-support/fake-api.js';
import { product, variant } from '../../test-support/inventory-fixtures.js';
import type { BillItem } from '../bill.js';

// Counter-sale data for component tests.

/** A valid Telangana GSTIN (36), and one of Andhra Pradesh (37) for an inter-state buyer. */
export const TS_GSTIN = '36AABCS1429B1ZV';
export const AP_GSTIN = '37AABCS1429B1ZT';

const store = (id: string, code: string, name: string, gstin: string | null): Store => ({
  id,
  code,
  name,
  type: 'store',
  city: 'Hyderabad',
  state: 'Telangana',
  gstin,
  isActive: true,
});

export const AMP = store('store-amp', 'AMP', 'Ameerpet', TS_GSTIN);
export const KPH = store('store-kph', 'KPH', 'Kukatpally', TS_GSTIN);
export const GODOWN: Store = { ...store('store-gdn', 'GDN', 'Godown', TS_GSTIN), type: 'godown' };

/** A counter cashier: a store employee at Ameerpet. */
export const CASHIER_POS = profile(
  ['stores:read', 'parties:read', 'catalog:read', 'inventory:read', 'sales:read', 'billing:issue'],
  {
    role: { key: 'store_employee', name: 'Store Employee' },
    allStores: false,
    storeIds: [AMP.id, KPH.id],
  },
);

export const OPTIONS: TaxCategoryOptions = {
  gstRegistered: true,
  categories: [
    { id: 'tax-paints', key: 'paints', name: 'Paints 18%', isDefault: true, currentRateBps: 1800 },
    { id: 'tax-tools', key: 'tools', name: 'Tools 12%', isDefault: false, currentRateBps: 1200 },
    { id: 'tax-exempt', key: 'exempt', name: 'Exempt', isDefault: false, currentRateBps: 0 },
    { id: 'tax-nil', key: 'nil', name: 'Nil rated', isDefault: false, currentRateBps: 0 },
    { id: 'tax-later', key: null, name: 'Later', isDefault: false, currentRateBps: null },
  ],
};

/** Apex 20 l at ₹10,450, barcode 8901000000017. */
export const APEX = product({
  variants: [
    variant({
      id: 'v-apex-20',
      sku: 'APX-20L',
      packSize: 20,
      sellingPricePaise: 1_045_000,
      barcodes: ['8901000000017'],
    }),
  ],
});
/** Putty 20 kg at ₹1,120. */
export const PUTTY = product({
  id: 'product-putty',
  name: 'Wall Putty',
  type: 'putty',
  hsnCode: '3214',
  variants: [
    variant({
      id: 'v-putty-20',
      sku: 'PUT-20KG',
      packSize: 20,
      unit: 'kg',
      sellingPricePaise: 112_000,
      barcodes: [],
    }),
  ],
});
/** Two roller sizes (labels) at ₹260 and ₹300, taxed at 12%. */
export const ROLLER = product({
  id: 'product-roller',
  name: 'Roller',
  type: 'tool',
  hsnCode: '9603',
  taxCategory: { id: 'tax-tools', name: 'Tools 12%' },
  variants: [
    variant({
      id: 'v-roller-9',
      sku: 'ROL-9',
      packSize: 1,
      unit: 'piece',
      label: '9 inch',
      sellingPricePaise: 26_000,
      barcodes: [],
    }),
    variant({
      id: 'v-roller-4',
      sku: 'ROL-4',
      packSize: 1,
      unit: 'piece',
      label: '4 inch',
      sellingPricePaise: 30_000,
      barcodes: [],
    }),
  ],
});

export const item = (overrides: Partial<BillItem> = {}): BillItem => ({
  variantId: 'v-apex-20',
  sku: 'APX-20L',
  name: 'Asian Paints Apex Ultima 20 l',
  taxCategoryId: 'tax-paints',
  unitPricePaise: 1_045_000,
  ...overrides,
});

export const MODES: PaymentModeView[] = [
  { id: 'mode-upi', kind: 'upi', name: 'UPI', isActive: true },
  { id: 'mode-cash', kind: 'cash', name: 'Cash', isActive: true },
  { id: 'mode-card', kind: 'card', name: 'Card', isActive: true },
  { id: 'mode-old', kind: 'other', name: 'Old wallet', isActive: false },
];

export const draftLine = (overrides: Partial<TaxDocumentLineView> = {}): TaxDocumentLineView => ({
  id: 'line-1',
  lineNo: 1,
  variantId: 'v-apex-20',
  description: null,
  hsnCode: null,
  uqc: null,
  quantity: 1,
  unitPricePaise: 1_045_000,
  discountBps: null,
  discountPaise: null,
  grossPaise: 0,
  taxablePaise: 0,
  taxCategoryId: null,
  rateBps: null,
  taxNature: null,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 0,
  cessPaise: 0,
  totalPaise: 0,
  ...overrides,
});

export const document = (overrides: Partial<TaxDocumentView> = {}): TaxDocumentView => ({
  id: 'draft-1',
  kind: 'invoice',
  status: 'draft',
  storeId: AMP.id,
  number: null,
  fy: null,
  issuedOn: null,
  issuedAt: null,
  supplier: { gstin: null, stateCode: null, legalName: null, tradeName: null, address: null },
  buyer: { partyId: null, name: null, gstin: null, address: null, stateCode: null },
  shipTo: { name: null, address: null, stateCode: null },
  placeOfSupplyCode: null,
  supplyType: null,
  gstClass: null,
  priceMode: 'inclusive',
  reverseCharge: false,
  billDiscountBps: null,
  billDiscountPaise: null,
  taxablePaise: 0,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 0,
  cessPaise: 0,
  roundOffPaise: 0,
  totalPaise: 0,
  dueOn: null,
  projectId: null,
  influencerPartyId: null,
  note: null,
  irn: null,
  ackNo: null,
  cancelReason: null,
  cancelledAt: null,
  lines: [draftLine()],
  taxRows: [],
  ...overrides,
});

/** An issued intra-state invoice for one Apex 20 l, paid in full. */
export const ISSUED: IssuedInvoiceView = {
  print: { bank: null, terms: [], aggregateTurnoverPaise: 0 },
  payments: [],
  paidPaise: 1_045_000,
  outstandingPaise: 0,
  changePaise: 0,
  ...document({
    status: 'issued',
    number: 'AMP/26-27/000001',
    fy: '2026-27',
    issuedOn: '2026-10-08',
    issuedAt: '2026-10-08T05:30:00.000Z',
    supplier: {
      gstin: TS_GSTIN,
      stateCode: '36',
      legalName: 'Sharma Paints LLP',
      tradeName: 'Sharma Paints',
      address: 'Ameerpet, Hyderabad',
    },
    placeOfSupplyCode: '36',
    supplyType: 'intra_state',
    gstClass: 'b2cs',
    taxablePaise: 885_593,
    cgstPaise: 79_703,
    sgstPaise: 79_703,
    roundOffPaise: 1,
    totalPaise: 1_045_000,
    lines: [
      draftLine({
        description: 'Asian Paints Apex Ultima 20 l',
        hsnCode: '3209',
        uqc: 'LTR',
        rateBps: 1800,
        taxNature: 'taxable',
        taxablePaise: 885_593,
        totalPaise: 1_044_999,
      }),
    ],
    taxRows: [
      {
        hsnCode: '3209',
        rateBps: 1800,
        taxablePaise: 885_593,
        cgstPaise: 79_703,
        sgstPaise: 79_703,
        igstPaise: 0,
        cessPaise: 0,
      },
    ],
  }),
};
