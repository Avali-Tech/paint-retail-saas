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
    readonly label: string | null;
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
  readonly variant: {
    readonly id: string;
    readonly sku: string;
    readonly packSize: number;
    readonly unit: string;
    readonly label: string | null;
  };
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

/** GET /stock/slow-movers: in-stock items with no sale or transfer out for `days` days. */
export interface SlowMover extends ItemRef {
  readonly onHand: number;
  /** When it last sold or was sent to another store; null if never. */
  readonly lastDemandAt: string | null;
  readonly daysIdle: number;
  /** On hand × average cost; null when the item has no cost. */
  readonly valuePaise: number | null;
  readonly productId: string;
  /** The other open store that sold most of it over the window; null when none did. */
  readonly sellsAt: {
    readonly store: { readonly id: string; readonly code: string; readonly name: string };
    readonly soldQuantity: number;
  } | null;
}

export interface SlowMoversQuery {
  readonly storeId?: string;
  readonly days: number;
  readonly limit: number;
  readonly offset: number;
}

/** GET /reorder-rules/suggestions: levels worked out from sales and supplier lead time. */
export interface ReorderSuggestion extends ItemRef {
  readonly soldQuantity: number;
  readonly dailyRate: number;
  readonly leadTimeDays: number;
  /** Where the lead time comes from; null: none on record, the default is used. */
  readonly supplierName: string | null;
  readonly current: Levels | null;
  readonly suggested: Levels;
}

export interface Levels {
  readonly minQuantity: number;
  readonly reorderLevel: number;
  readonly maxQuantity: number;
}

export interface SuggestionsQuery {
  readonly storeId: string;
  readonly days: number;
  readonly safetyDays: number;
  readonly limit: number;
  readonly offset: number;
}

/** A store's free quantity of one product, and nothing more of its stock. */
export interface FreeStock {
  readonly store: { readonly id: string; readonly code: string; readonly name: string };
  readonly available: number;
  /** Its average cost there; null without costs:read or without a cost. */
  readonly avgCostPaise: number | null;
}

/** GET /stock/free-elsewhere: the stores with it free, and what bringing it over costs. */
export interface FreeElsewhere {
  /** null when the business has not set it (Settings → Stock alerts and transfers). */
  readonly deliveryCostPaise: number | null;
  readonly stores: readonly FreeStock[];
}

export function stockEndpoints(api: ApiClient) {
  return {
    stores: () => api.get<Store[]>('/stores'),
    /** Every open store of the business, also those the member does not work at. */
    storeDirectory: () => api.get<StoreDirectoryEntry[]>('/stores/directory'),
    balances: (query: StockQuery, signal?: AbortSignal) =>
      api.get<Page<StockRow>>('/stock', { query: { ...query }, signal }),
    record: (input: MovementInput) => api.post<Page<LedgerEntry>>('/stock/movements', input),
    freeElsewhere: (variantId: string, signal?: AbortSignal) =>
      api.get<FreeElsewhere>('/stock/free-elsewhere', { query: { variantId }, signal }),
    low: (query: { storeId?: string; limit: number; offset: number }, signal?: AbortSignal) =>
      api.get<Page<LowStockItem>>('/stock/low', { query: { ...query }, signal }),
    slowMovers: (query: SlowMoversQuery, signal?: AbortSignal) =>
      api.get<Page<SlowMover>>('/stock/slow-movers', { query: { ...query }, signal }),
    suggestions: (query: SuggestionsQuery, signal?: AbortSignal) =>
      api.get<Page<ReorderSuggestion>>('/reorder-rules/suggestions', {
        query: { ...query },
        signal,
      }),
    rules: (query: RuleQuery, signal?: AbortSignal) =>
      api.get<Page<ReorderRule>>('/reorder-rules', { query: { ...query }, signal }),
    saveRules: (rules: RuleInput[]) => api.put<{ saved: number }>('/reorder-rules', { rules }),
    deleteRule: (storeId: string, variantId: string) =>
      api.delete<undefined>(`/reorder-rules/${storeId}/${variantId}`),
  };
}
