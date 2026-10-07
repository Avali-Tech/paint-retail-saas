import type { ApiClient } from './client.js';
import type { Page } from './page.js';

// Stock transfers between stores and their delivery challan.
// Shapes mirror apps/api/src/transfers.

export const TRANSFER_STATUSES = [
  'requested',
  'approved',
  'in_transit',
  'received',
  'rejected',
  'cancelled',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export interface StoreSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface TransferLine {
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly brandName: string;
  readonly packSize: number;
  readonly unit: string;
  /** Tells same-sized packs apart, e.g. "2 inch"; see variantName. */
  readonly label: string | null;
  readonly hsnCode: string;
  readonly requestedQuantity: number;
  readonly approvedQuantity: number | null;
  readonly dispatchedQuantity: number | null;
  readonly receivedQuantity: number | null;
  readonly damagedQuantity: number | null;
  /** Dispatched but never arrived; known once received. */
  readonly shortQuantity: number | null;
  readonly unitCostPaise: number | null;
  /** Available now at the sending store, to help the approver. */
  readonly availableAtSource: number;
}

export interface Transfer {
  readonly id: string;
  readonly number: string;
  readonly status: TransferStatus;
  readonly from: StoreSummary;
  readonly to: StoreSummary;
  readonly note: string | null;
  readonly closingReason: string | null;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly dispatchedAt: string | null;
  readonly receivedAt: string | null;
  readonly closedAt: string | null;
  readonly lines: TransferLine[];
}

export interface TransferSummary {
  readonly id: string;
  readonly number: string;
  readonly status: TransferStatus;
  readonly from: StoreSummary;
  readonly to: StoreSummary;
  readonly requestedAt: string;
  readonly lineCount: number;
}

export interface TransferQuery {
  readonly status?: TransferStatus;
  /** Relative to the member's stores. */
  readonly direction?: 'incoming' | 'outgoing';
  readonly storeId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ChallanParty {
  readonly name: string;
  readonly code: string;
  readonly city: string | null;
  readonly state: string | null;
  readonly gstin: string | null;
}

export interface Challan {
  readonly number: string;
  readonly dispatchedAt: string;
  readonly from: ChallanParty;
  readonly to: ChallanParty;
  /** Different GSTINs: the move is a taxable supply and needs a tax invoice. */
  readonly requiresTaxInvoice: boolean;
  readonly lines: {
    readonly sku: string;
    readonly description: string;
    readonly hsnCode: string;
    readonly quantity: number;
    readonly unitValuePaise: number | null;
    readonly valuePaise: number | null;
  }[];
  readonly totalValuePaise: number;
}

export interface QuantityLine {
  readonly variantId: string;
  readonly quantity: number;
}

export interface ReceiveLine {
  readonly variantId: string;
  readonly received: number;
  readonly damaged: number;
}

export function transferEndpoints(api: ApiClient) {
  return {
    list: (query: TransferQuery, signal?: AbortSignal) =>
      api.get<Page<TransferSummary>>('/transfers', { query: { ...query }, signal }),
    get: (id: string, signal?: AbortSignal) => api.get<Transfer>(`/transfers/${id}`, { signal }),
    challan: (id: string, signal?: AbortSignal) =>
      api.get<Challan>(`/transfers/${id}/challan`, { signal }),
    create: (input: {
      fromStoreId: string;
      toStoreId: string;
      note?: string;
      lines: QuantityLine[];
    }) => api.post<Transfer>('/transfers', input),
    approve: (id: string, lines?: QuantityLine[]) =>
      api.post<Transfer>(`/transfers/${id}/approve`, lines === undefined ? {} : { lines }),
    reject: (id: string, reason: string) =>
      api.post<Transfer>(`/transfers/${id}/reject`, { reason }),
    cancel: (id: string, reason: string) =>
      api.post<Transfer>(`/transfers/${id}/cancel`, { reason }),
    dispatch: (id: string, lines?: QuantityLine[]) =>
      api.post<Transfer>(`/transfers/${id}/dispatch`, lines === undefined ? {} : { lines }),
    receive: (id: string, input: { note?: string; lines?: ReceiveLine[] }) =>
      api.post<Transfer>(`/transfers/${id}/receive`, input),
  };
}
