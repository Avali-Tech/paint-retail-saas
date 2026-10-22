import '../styles/inventory.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Stock screens, each its own chunk loaded when first opened.
const StockPage = lazy(() =>
  import('./StockPage.js').then((module) => ({ default: module.StockPage })),
);
const MovementPage = lazy(() =>
  import('./MovementPage.js').then((module) => ({ default: module.MovementPage })),
);
const LowStockPage = lazy(() =>
  import('./LowStockPage.js').then((module) => ({ default: module.LowStockPage })),
);
const SlowMoversPage = lazy(() =>
  import('./SlowMoversPage.js').then((module) => ({ default: module.SlowMoversPage })),
);
const ReorderSuggestionsPage = lazy(() =>
  import('./ReorderSuggestionsPage.js').then((module) => ({
    default: module.ReorderSuggestionsPage,
  })),
);
const ReorderRulesPage = lazy(() =>
  import('./ReorderRulesPage.js').then((module) => ({ default: module.ReorderRulesPage })),
);

/** The stock screens, inside the signed-in shell. */
export function stockRoutes() {
  return (
    <>
      <Route path="stock" element={guarded('inventory:read', StockPage)} />
      <Route path="stock/movements/new" element={guarded('inventory:manage', MovementPage)} />
      <Route path="stock/low" element={guarded('inventory:read', LowStockPage)} />
      <Route path="stock/slow-movers" element={guarded('inventory:read', SlowMoversPage)} />
      <Route path="stock/reorder-rules" element={guarded('inventory:read', ReorderRulesPage)} />
      <Route
        path="stock/reorder-rules/suggestions"
        element={guarded('inventory:read', ReorderSuggestionsPage)}
      />
    </>
  );
}
