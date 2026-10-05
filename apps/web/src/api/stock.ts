import type { StoreDirectoryEntry } from '@paint/shared';
import type { ApiClient } from './client.js';
import type { Page } from './page.js';

// Stores, stock balances and movements, reorder rules and low stock.
// Shapes mirror apps/api/src/{stores,inventory,reorder}.

export interface Store {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly type: 'store' | 'godown';
  readonly city: string | null;
  readonly state: string | null;
  readonly gstin: string | null;
  readonly isActive: boolean;
}

export interface StockRow {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly variant: {
    readonly id: string;
    readonly sku: string;
    readonly packSize: number;
    readonly unit: string;
  };
  readonly product: { readonly id: string; readonly name: string };
  readonly brand: { readonly id: string; readonly name: string };
  readonly onHand: number;
  readonly reserved: number;
  readonly available: number;
  readonly avgCostPaise: number | null;
  readonly valuePaise: number | null;
}

export interface StockQuery {
  readonly storeId?: string;
  readonly productId?: string;
  readonly q?: string;
  readonly inStockOnly?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export const MOVEMENT_KINDS = ['adjustment', 'damage', 'opening'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

export interface MovementInput {
  readonly storeId: string;
  readonly type: MovementKind;
  readonly note?: string;
  readonly lines: { variantId: string; quantity: number; unitCostPaise?: number }[];
}

/** One ledger entry, as POST /stock/movements answers for each line it posted. */
export interface LedgerEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly movementType: string;
  readonly quantity: number;
  readonly unitCostPaise: number | null;
  readonly note: string | null;
  readonly store: { readonly id: string; readonly code: string };
  readonly variant: { readonly id: string; readonly sku: string };
  readonly createdBy: string | null;
}

/** A store and product, as reorder rules and low stock name them. */
export interface ItemRef {
  readonly store: { readonly id: string; readonly code: string };
  readonly variant: { readonly id: string; readonly sku: string };
  readonly product: { readonly name: string };
  readonly brand: { readonly name: string };
}

export interface ReorderRule extends ItemRef {
  readonly minQuantity: number;
  readonly reorderLevel: number;
  readonly maxQuantity: number;
}

export interface RuleInput {
  readonly storeId: string;
  readonly variantId: string;
  readonly minQuantity: number;
  readonly reorderLevel: number;
  readonly maxQuantity: number;
}

export interface RuleQuery {
  readonly storeId?: string;
  readonly q?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export type Severity = 'out_of_stock' | 'below_minimum' | 'reorder';

export interface LowStockItem extends ReorderRule {
  readonly onHand: number;
  readonly available: number;
  readonly severity: Severity;
  readonly suggestedQuantity: number;
}

export function stockEndpoints(api: ApiClient) {
  return {
    stores: () => api.get<Store[]>('/stores'),
    /** Every open store of the business, also those the member does not work at. */
    storeDirectory: () => api.get<StoreDirectoryEntry[]>('/stores/directory'),
    balances: (query: StockQuery, signal?: AbortSignal) =>
      api.get<Page<StockRow>>('/stock', { query: { ...query }, signal }),
    record: (input: MovementInput) => api.post<Page<LedgerEntry>>('/stock/movements', input),
    low: (query: { storeId?: string; limit: number; offset: number }, signal?: AbortSignal) =>
      api.get<Page<LowStockItem>>('/stock/low', { query: { ...query }, signal }),
    rules: (query: RuleQuery, signal?: AbortSignal) =>
      api.get<Page<ReorderRule>>('/reorder-rules', { query: { ...query }, signal }),
    saveRules: (rules: RuleInput[]) => api.put<{ saved: number }>('/reorder-rules', { rules }),
    deleteRule: (storeId: string, variantId: string) =>
      api.delete<undefined>(`/reorder-rules/${storeId}/${variantId}`),
  };
}
