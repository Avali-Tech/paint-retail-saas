import '../styles/inventory.css';
import './transfers.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Transfer screens, each its own chunk loaded when first opened.
const TransfersPage = lazy(() =>
  import('./TransfersPage.js').then((module) => ({ default: module.TransfersPage })),
);
const NewTransferPage = lazy(() =>
  import('./NewTransferPage.js').then((module) => ({ default: module.NewTransferPage })),
);
const TransferDetailPage = lazy(() =>
  import('./TransferDetailPage.js').then((module) => ({ default: module.TransferDetailPage })),
);

/** The transfer screens, inside the signed-in shell. */
export function transferRoutes() {
  return (
    <>
      <Route path="transfers" element={guarded('inventory:read', TransfersPage)} />
      <Route path="transfers/new" element={guarded('inventory:manage', NewTransferPage)} />
      <Route path="transfers/:id" element={guarded('inventory:read', TransferDetailPage)} />
    </>
  );
}
