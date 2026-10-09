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
const AccountingExportPage = lazy(() =>
  import('./AccountingExportPage.js').then((module) => ({ default: module.AccountingExportPage })),
);
const LedgerMappingsPage = lazy(() =>
  import('./LedgerMappingsPage.js').then((module) => ({ default: module.LedgerMappingsPage })),
);

/** The books screens, inside the signed-in shell. */
export function booksRoutes() {
  return (
    <>
      <Route path="registers" element={guarded('register:manage', RegistersPage)} />
      <Route path="registers/:id" element={guarded('register:manage', RegisterSessionPage)} />
      <Route path="payments" element={guarded('sales:read', PaymentsPage)} />
      <Route path="accounting" element={<Navigate to="/accounting/export" replace />} />
      <Route
        path="accounting/export"
        element={guarded('accounting:export', AccountingExportPage)}
      />
      <Route path="accounting/ledgers" element={guarded('accounting:export', LedgerMappingsPage)} />
    </>
  );
}
