import { lazy } from 'react';
import { Navigate, Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// The day end, payments and the Tally export, each its own chunk loaded when first opened.
const RegistersPage = lazy(() =>
  import('./RegistersPage.js').then((module) => ({ default: module.RegistersPage })),
);
const RegisterSessionPage = lazy(() =>
  import('./RegisterSessionPage.js').then((module) => ({ default: module.RegisterSessionPage })),
);
const PaymentsPage = lazy(() =>
  import('./PaymentsPage.js').then((module) => ({ default: module.PaymentsPage })),
);
const TakePaymentPage = lazy(() =>
  import('./TakePaymentPage.js').then((module) => ({ default: module.TakePaymentPage })),
);
const PaymentPage = lazy(() =>
  import('./PaymentPage.js').then((module) => ({ default: module.PaymentPage })),
);
const AccountingExportPage = lazy(() =>
  import('./AccountingExportPage.js').then((module) => ({ default: module.AccountingExportPage })),
);
const LedgerMappingsPage = lazy(() =>
  import('./LedgerMappingsPage.js').then((module) => ({ default: module.LedgerMappingsPage })),
);
const ReconciliationPage = lazy(() =>
  import('./ReconciliationPage.js').then((module) => ({ default: module.ReconciliationPage })),
);

/** The books screens, inside the signed-in shell. */
export function booksRoutes() {
  return (
    <>
      <Route path="registers" element={guarded('register:manage', RegistersPage)} />
      <Route path="registers/:id" element={guarded('register:manage', RegisterSessionPage)} />
      <Route path="payments" element={guarded('sales:read', PaymentsPage)} />
      <Route path="payments/new" element={guarded('payments:manage', TakePaymentPage)} />
      <Route path="payments/:id" element={guarded('sales:read', PaymentPage)} />
      <Route path="accounting" element={<Navigate to="/accounting/export" replace />} />
      <Route
        path="accounting/export"
        element={guarded('accounting:export', AccountingExportPage)}
      />
      <Route path="accounting/ledgers" element={guarded('accounting:export', LedgerMappingsPage)} />
      <Route
        path="accounting/reconciliation"
        element={guarded('accounting:reconcile', ReconciliationPage)}
      />
    </>
  );
}
