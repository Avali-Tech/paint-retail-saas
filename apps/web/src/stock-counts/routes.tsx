import '../styles/inventory.css';
import './stock-counts.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Stock count screens, each its own chunk loaded when first opened.
const StockCountsPage = lazy(() =>
  import('./StockCountsPage.js').then((module) => ({ default: module.StockCountsPage })),
);
const NewStockCountPage = lazy(() =>
  import('./NewStockCountPage.js').then((module) => ({ default: module.NewStockCountPage })),
);
const StockCountDetailPage = lazy(() =>
  import('./StockCountDetailPage.js').then((module) => ({
    default: module.StockCountDetailPage,
  })),
);

/** The stock count screens, inside the signed-in shell. */
export function stockCountRoutes() {
  return (
    <>
      <Route path="stock-counts" element={guarded('inventory:read', StockCountsPage)} />
      <Route path="stock-counts/new" element={guarded('inventory:manage', NewStockCountPage)} />
      <Route path="stock-counts/:id" element={guarded('inventory:read', StockCountDetailPage)} />
    </>
  );
}
