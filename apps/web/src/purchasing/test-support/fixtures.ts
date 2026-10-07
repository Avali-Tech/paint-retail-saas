import type { Product } from '../../api/catalog.js';
import type {
  GoodsReceipt,
  GoodsReceiptSummary,
  PurchaseOrder,
  PurchaseOrderSummary,
  Supplier,
  SupplierSummary,
} from '../../api/purchasing.js';
import type { Store } from '../../api/stock.js';
import { OWNER, json, profile, type FakeHandler } from '../../test-support/fake-api.js';

const store = (id: string, code: string, name: string): Store => ({
  id,
  code,
  name,
  type: 'store',
  city: null,
  state: null,
  gstin: null,
  isActive: true,
});

export const STORES = [store('s-hyd', 'HYD', 'Hyderabad'), store('s-pun', 'PUN', 'Pune')];
const HYD = { id: 's-hyd', code: 'HYD', name: 'Hyderabad' };

export const SUPPLIER_SUMMARY: SupplierSummary = {
  id: 'sup-1',
  name: 'Shah Distributors',
  phone: '+919876543210',
  gstin: '36AABCS1429B1ZB',
  paymentTermsDays: 30,
  leadTimeDays: 4,
  productCount: 2,
};

export const CASH_SUPPLIER: SupplierSummary = {
  id: 'sup-2',
  name: 'Ravi Traders',
  phone: null,
  gstin: null,
  paymentTermsDays: 0,
  leadTimeDays: null,
  productCount: 0,
};

export const SUPPLIER: Supplier = {
  ...SUPPLIER_SUMMARY,
  products: [
    {
      variantId: 'v-1l',
      sku: 'APX-1L',
      productName: 'Apex Ultima',
      brandName: 'Asian Paints',
      packSize: 1,
      unit: 'l',
      label: null,
      supplierSku: 'SH-001',
      lastCostPaise: 40_000,
      lastReceivedAt: '2026-09-20T05:00:00.000Z',
    },
    {
      variantId: 'v-4l',
      sku: 'APX-4L',
      productName: 'Apex Ultima',
      brandName: 'Asian Paints',
      packSize: 4,
      unit: 'l',
      label: null,
      supplierSku: null,
      lastCostPaise: null,
      lastReceivedAt: null,
    },
  ],
};

export const PRODUCT: Product = {
  id: 'p-1',
  name: 'Tractor Emulsion',
  type: 'interior_paint',
  description: null,
  hsnCode: '3209',
  gstRatePercent: 18,
  taxCategory: { id: 'tax-paints', name: 'Paints 18%' },
  isActive: true,
  brand: { id: 'b-1', name: 'Asian Paints' },
  category: null,
  variants: [
    {
      id: 'v-te',
      sku: 'TE-10L',
      packSize: 10,
      unit: 'l',
      label: null,
      mrpPaise: 300_000,
      sellingPricePaise: 280_000,
      isActive: true,
      barcodes: [],
    },
    {
      id: 'v-te20',
      sku: 'TE-20L',
      packSize: 20,
      unit: 'l',
      label: null,
      mrpPaise: null,
      sellingPricePaise: null,
      isActive: true,
      barcodes: [],
    },
  ],
};

export const ORDER: PurchaseOrder = {
  id: 'po-1',
  number: 'PO-000001',
  status: 'open',
  supplier: { id: 'sup-1', name: 'Shah Distributors', gstin: null },
  store: HYD,
  expectedDate: '2026-10-05',
  note: 'Before Diwali',
  closingReason: null,
  createdAt: '2026-10-01T05:00:00.000Z',
  closedAt: null,
  lines: [
    {
      variantId: 'v-1l',
      sku: 'APX-1L',
      productName: 'Apex Ultima',
      brandName: 'Asian Paints',
      packSize: 1,
      unit: 'l',
      label: null,
      orderedQuantity: 10,
      receivedQuantity: 0,
      pendingQuantity: 10,
      unitCostPaise: 40_000,
      valuePaise: 400_000,
    },
    {
      variantId: 'v-4l',
      sku: 'APX-4L',
      productName: 'Apex Ultima',
      brandName: 'Asian Paints',
      packSize: 4,
      unit: 'l',
      label: null,
      orderedQuantity: 2,
      receivedQuantity: 2,
      pendingQuantity: 0,
      unitCostPaise: null,
      valuePaise: null,
    },
  ],
  totalValuePaise: 400_000,
  receipts: [],
};

export const ORDER_SUMMARY: PurchaseOrderSummary = {
  id: 'po-1',
  number: 'PO-000001',
  status: 'partially_received',
  supplier: { id: 'sup-1', name: 'Shah Distributors' },
  store: HYD,
  expectedDate: null,
  createdAt: '2026-10-01T05:00:00.000Z',
  lineCount: 2,
  totalValuePaise: 400_000,
};

export const RECEIPT: GoodsReceipt = {
  id: 'grn-1',
  number: 'GRN-000001',
  store: HYD,
  supplier: { id: 'sup-1', name: 'Shah Distributors', gstin: null },
  purchaseOrder: { id: 'po-1', number: 'PO-000001' },
  supplierInvoiceNumber: 'INV-77',
  supplierInvoiceDate: '2026-10-02',
  note: 'Two dented',
  receivedAt: '2026-10-02T06:00:00.000Z',
  lines: [
    {
      variantId: 'v-1l',
      sku: 'APX-1L',
      productName: 'Apex Ultima',
      brandName: 'Asian Paints',
      packSize: 1,
      unit: 'l',
      label: null,
      quantity: 6,
      freeQuantity: 1,
      unitCostPaise: 40_000,
      valuePaise: 240_000,
    },
    {
      variantId: 'v-4l',
      sku: 'APX-4L',
      productName: 'Apex Ultima',
      brandName: 'Asian Paints',
      packSize: 4,
      unit: 'l',
      label: null,
      quantity: 1,
      freeQuantity: 0,
      unitCostPaise: null,
      valuePaise: null,
    },
  ],
  totalValuePaise: 240_000,
};

export const RECEIPT_SUMMARY: GoodsReceiptSummary = {
  id: 'grn-1',
  number: 'GRN-000001',
  store: HYD,
  supplier: { id: 'sup-1', name: 'Shah Distributors' },
  purchaseOrderNumber: 'PO-000001',
  supplierInvoiceNumber: null,
  receivedAt: '2026-10-02T06:00:00.000Z',
  totalValuePaise: 240_000,
};

/** Can see purchasing but not change it. */
export const VIEWER = profile(['stores:read', 'purchasing:read', 'catalog:read'], {
  allStores: false,
  storeIds: ['s-hyd'],
});

/** The routes every purchasing screen needs: the member, stores, suppliers, products. */
export function purchasingRoutes(member = OWNER): Record<string, FakeHandler> {
  return {
    'GET /auth/me': () => json(member),
    'GET /stores': () => json(STORES),
    'GET /suppliers': () => json({ items: [SUPPLIER_SUMMARY, CASH_SUPPLIER], total: 2 }),
    'GET /suppliers/:id': () => json(SUPPLIER),
    'GET /products': () => json({ items: [PRODUCT], total: 1 }),
  };
}
