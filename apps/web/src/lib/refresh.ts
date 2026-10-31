import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Everything a stock or purchasing change can move: balances, low stock, the
 * documents that list quantities and costs, suppliers' last costs, the dashboard
 * and the inbox (with its badge).
 */
const INVENTORY_QUERIES: ReadonlySet<unknown> = new Set([
  'stock',
  'low-stock',
  'reorder-rules',
  'transfers',
  'transfer',
  'stock-counts',
  'stock-count',
  'purchase-orders',
  'purchase-order',
  'goods-receipts',
  'goods-receipt',
  'suppliers',
  'supplier',
  'dashboard',
  'inbox',
]);

/**
 * Reloads every inventory screen after a change (only screens on view refetch at
 * once). `keep` is a record the caller has just stored from the API's answer.
 */
export function refreshInventory(queryClient: QueryClient, keep?: QueryKey): Promise<void> {
  const kept = keep === undefined ? null : hashKey(keep);
  return queryClient.invalidateQueries({
    predicate: (query) => INVENTORY_QUERIES.has(query.queryKey[0]) && query.queryHash !== kept,
  });
}
