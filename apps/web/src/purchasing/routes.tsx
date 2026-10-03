import '../styles/inventory.css';
import './purchasing.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Purchasing screens, each its own chunk loaded when first opened.
const SuppliersPage = lazy(() =>
  import('./SuppliersPage.js').then((module) => ({ default: module.SuppliersPage })),
);
const SupplierDetailPage = lazy(() =>
  import('./SupplierDetailPage.js').then((module) => ({ default: module.SupplierDetailPage })),
);
const PurchaseOrdersPage = lazy(() =>
  import('./PurchaseOrdersPage.js').then((module) => ({ default: module.PurchaseOrdersPage })),
);
const NewPurchaseOrderPage = lazy(() =>
  import('./NewPurchaseOrderPage.js').then((module) => ({
    default: module.NewPurchaseOrderPage,
  })),
);
const PurchaseOrderDetailPage = lazy(() =>
  import('./PurchaseOrderDetailPage.js').then((module) => ({
    default: module.PurchaseOrderDetailPage,
  })),
);
const GoodsReceiptsPage = lazy(() =>
  import('./GoodsReceiptsPage.js').then((module) => ({ default: module.GoodsReceiptsPage })),
);
const NewGoodsReceiptPage = lazy(() =>
  import('./NewGoodsReceiptPage.js').then((module) => ({ default: module.NewGoodsReceiptPage })),
);
const GoodsReceiptDetailPage = lazy(() =>
  import('./GoodsReceiptDetailPage.js').then((module) => ({
    default: module.GoodsReceiptDetailPage,
  })),
);

/** The purchasing screens, inside the signed-in shell. */
export function purchasingRoutes() {
  return (
    <>
      <Route path="suppliers" element={guarded('purchasing:read', SuppliersPage)} />
      <Route path="suppliers/:id" element={guarded('purchasing:read', SupplierDetailPage)} />
      <Route path="purchase-orders" element={guarded('purchasing:read', PurchaseOrdersPage)} />
      <Route
        path="purchase-orders/new"
        element={guarded('purchasing:manage', NewPurchaseOrderPage)}
      />
      <Route
        path="purchase-orders/:id"
        element={guarded('purchasing:read', PurchaseOrderDetailPage)}
      />
      <Route path="goods-receipts" element={guarded('purchasing:read', GoodsReceiptsPage)} />
      <Route
        path="goods-receipts/new"
        element={guarded('purchasing:manage', NewGoodsReceiptPage)}
      />
      <Route
        path="goods-receipts/:id"
        element={guarded('purchasing:read', GoodsReceiptDetailPage)}
      />
    </>
  );
}
