import '../pos/pos.css';
import './orders.css';
import { ORDERS_PERMISSION } from '@paint/shared';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Quotations and sales orders (spec §5.3), each screen its own chunk loaded when first
// opened. The editor uses the counter's line grid, hence the POS styles.
const QuotationsPage = lazy(() =>
  import('./QuotationsPage.js').then((module) => ({ default: module.QuotationsPage })),
);
const QuotationPage = lazy(() =>
  import('./QuotationPage.js').then((module) => ({ default: module.QuotationPage })),
);
const SalesOrdersPage = lazy(() =>
  import('./SalesOrdersPage.js').then((module) => ({ default: module.SalesOrdersPage })),
);
const OrderPage = lazy(() =>
  import('./OrderPage.js').then((module) => ({ default: module.OrderPage })),
);
const NewQuotationPage = lazy(() =>
  import('./EditorPages.js').then((module) => ({ default: module.NewQuotationPage })),
);
const EditQuotationPage = lazy(() =>
  import('./EditorPages.js').then((module) => ({ default: module.EditQuotationPage })),
);
const NewOrderPage = lazy(() =>
  import('./EditorPages.js').then((module) => ({ default: module.NewOrderPage })),
);
const EditOrderPage = lazy(() =>
  import('./EditorPages.js').then((module) => ({ default: module.EditOrderPage })),
);

/** The quotation and order screens, inside the signed-in shell. */
export function orderRoutes() {
  return (
    <>
      <Route path="quotations" element={guarded('sales:read', QuotationsPage)} />
      <Route path="quotations/new" element={guarded(ORDERS_PERMISSION, NewQuotationPage)} />
      <Route path="quotations/:id" element={guarded('sales:read', QuotationPage)} />
      <Route path="quotations/:id/edit" element={guarded(ORDERS_PERMISSION, EditQuotationPage)} />
      <Route path="sales-orders" element={guarded('sales:read', SalesOrdersPage)} />
      <Route path="sales-orders/new" element={guarded(ORDERS_PERMISSION, NewOrderPage)} />
      <Route path="sales-orders/:id" element={guarded('sales:read', OrderPage)} />
      <Route path="sales-orders/:id/edit" element={guarded(ORDERS_PERMISSION, EditOrderPage)} />
    </>
  );
}
