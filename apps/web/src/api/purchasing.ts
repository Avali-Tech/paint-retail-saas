import type { ApiClient } from './client.js';
import type { Page } from './page.js';

// Suppliers, purchase orders and goods receipts.
// Shapes mirror apps/api/src/purchasing.

export interface SupplierSummary {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly gstin: string | null;
  /** Days of credit; 0 = cash. */
  readonly paymentTermsDays: number;
  readonly leadTimeDays: number | null;
  readonly productCount: number;
}

export interface SupplierProduct {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly packSize: number;
  readonly unit: string;
  /** Tells same-sized packs apart, e.g. "2 inch"; see variantName. */
  readonly label: string | null;
  readonly supplierSku: string | null;
  readonly lastCostPaise: number | null;
  readonly lastReceivedAt: string | null;
}

export interface Supplier extends SupplierSummary {
  readonly products: SupplierProduct[];
}

/** A new supplier: a party with the supplier role (POST /parties). */
export interface NewSupplier {
  readonly kind: 'person' | 'organization';
  readonly displayName: string;
  readonly phone?: string;
  readonly gstin?: string;
  readonly city?: string;
}

export const PURCHASE_ORDER_STATUSES = [
  'open',
  'partially_received',
  'received',
  'closed',
  'cancelled',
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export interface PartySummary {
  readonly id: string;
  readonly name: string;
  readonly gstin: string | null;
}

export interface StoreSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface PurchaseOrderLine {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly packSize: number;
  readonly unit: string;
  readonly label: string | null;
  readonly orderedQuantity: number;
  readonly receivedQuantity: number;
  /** Still to arrive. */
  readonly pendingQuantity: number;
  readonly unitCostPaise: number | null;
  readonly valuePaise: number | null;
}

export interface PurchaseOrder {
  readonly id: string;
  readonly number: string;
  readonly status: PurchaseOrderStatus;
  readonly supplier: PartySummary;
  readonly store: StoreSummary;
  readonly expectedDate: string | null;
  readonly note: string | null;
  readonly closingReason: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
  readonly lines: PurchaseOrderLine[];
  /** Ordered value of the lines with a known cost. */
  readonly totalValuePaise: number;
  readonly receipts: {
    readonly id: string;
    readonly number: string;
    readonly supplierInvoiceNumber: string | null;
    readonly receivedAt: string;
  }[];
}

export interface PurchaseOrderSummary {
  readonly id: string;
  readonly number: string;
  readonly status: PurchaseOrderStatus;
  readonly supplier: { readonly id: string; readonly name: string };
  readonly store: StoreSummary;
  readonly expectedDate: string | null;
  readonly createdAt: string;
  readonly lineCount: number;
  readonly totalValuePaise: number;
}

export interface PurchaseOrderQuery {
  readonly status?: PurchaseOrderStatus;
  readonly storeId?: string;
  readonly supplierId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface PurchaseOrderInput {
  readonly supplierId: string;
  readonly storeId: string;
  /** yyyy-mm-dd */
  readonly expectedDate?: string;
  readonly note?: string;
  readonly lines: { variantId: string; quantity: number; unitCostPaise?: number }[];
}

export interface GoodsReceiptLine {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly packSize: number;
  readonly unit: string;
  /** Tells same-sized packs apart, e.g. "2 inch"; see variantName. */
  readonly label: string | null;
  readonly quantity: number;
  readonly freeQuantity: number;
  readonly unitCostPaise: number | null;
  /** Paid units × cost; free units carry no value. */
  readonly valuePaise: number | null;
}

export interface GoodsReceipt {
  readonly id: string;
  readonly number: string;
  readonly store: StoreSummary;
  readonly supplier: PartySummary;
  readonly purchaseOrder: { readonly id: string; readonly number: string } | null;
  readonly supplierInvoiceNumber: string | null;
  readonly supplierInvoiceDate: string | null;
  readonly note: string | null;
  readonly receivedAt: string;
  readonly lines: GoodsReceiptLine[];
  readonly totalValuePaise: number;
}

export interface GoodsReceiptSummary {
  readonly id: string;
  readonly number: string;
  readonly store: StoreSummary;
  readonly supplier: { readonly id: string; readonly name: string };
  readonly purchaseOrderNumber: string | null;
  readonly supplierInvoiceNumber: string | null;
  readonly receivedAt: string;
  readonly totalValuePaise: number;
}

export interface GoodsReceiptQuery {
  readonly storeId?: string;
  readonly supplierId?: string;
  readonly purchaseOrderId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Against an order (store and supplier come from it), or a supplier's invoice. */
export interface GoodsReceiptInput {
  readonly purchaseOrderId?: string;
  readonly storeId?: string;
  readonly supplierId?: string;
  readonly supplierInvoiceNumber?: string;
  /** yyyy-mm-dd */
  readonly supplierInvoiceDate?: string;
  readonly note?: string;
  readonly lines: {
    variantId: string;
    quantity: number;
    /** Scheme units given free, at zero cost. */
    freeQuantity: number;
    unitCostPaise?: number;
  }[];
}

export function purchasingEndpoints(api: ApiClient) {
  return {
    suppliers: (query: { q?: string; limit?: number; offset?: number }, signal?: AbortSignal) =>
      api.get<Page<SupplierSummary>>('/suppliers', { query: { ...query }, signal }),
    supplier: (id: string, signal?: AbortSignal) =>
      api.get<Supplier>(`/suppliers/${id}`, { signal }),
    createSupplier: (input: NewSupplier) =>
      api.post<{ id: string }>('/parties', { ...input, roles: ['supplier'] }),
    saveSupplierProfile: (
      id: string,
      profile: { paymentTermsDays: number; leadTimeDays: number | null },
    ) => api.put<Supplier>(`/suppliers/${id}/profile`, profile),
    saveSupplierProducts: (
      id: string,
      products: { variantId: string; supplierSku: string | null }[],
    ) => api.put<Supplier>(`/suppliers/${id}/products`, { products }),
    removeSupplierProduct: (id: string, variantId: string) =>
      api.delete<undefined>(`/suppliers/${id}/products/${variantId}`),

    orders: (query: PurchaseOrderQuery, signal?: AbortSignal) =>
      api.get<Page<PurchaseOrderSummary>>('/purchase-orders', { query: { ...query }, signal }),
    order: (id: string, signal?: AbortSignal) =>
      api.get<PurchaseOrder>(`/purchase-orders/${id}`, { signal }),
    createOrder: (input: PurchaseOrderInput) => api.post<PurchaseOrder>('/purchase-orders', input),
    orderFromLowStock: (input: {
      supplierId: string;
      storeId: string;
      variantIds?: string[];
      expectedDate?: string;
      note?: string;
    }) => api.post<PurchaseOrder>('/purchase-orders/from-low-stock', input),
    cancelOrder: (id: string, reason: string) =>
      api.post<PurchaseOrder>(`/purchase-orders/${id}/cancel`, { reason }),
    closeOrder: (id: string, reason: string) =>
      api.post<PurchaseOrder>(`/purchase-orders/${id}/close`, { reason }),

    receipts: (query: GoodsReceiptQuery, signal?: AbortSignal) =>
      api.get<Page<GoodsReceiptSummary>>('/goods-receipts', { query: { ...query }, signal }),
    receipt: (id: string, signal?: AbortSignal) =>
      api.get<GoodsReceipt>(`/goods-receipts/${id}`, { signal }),
    receive: (input: GoodsReceiptInput) => api.post<GoodsReceipt>('/goods-receipts', input),
  };
}
