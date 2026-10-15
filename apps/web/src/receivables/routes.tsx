import { RECEIVABLES_PERMISSION, STATEMENT_PERMISSION } from '@paint/shared';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Receivables and statements, each its own chunk loaded when first opened.
const ReceivablesPage = lazy(() =>
  import('./ReceivablesPage.js').then((module) => ({ default: module.ReceivablesPage })),
);
const StatementPage = lazy(() =>
  import('./StatementPage.js').then((module) => ({ default: module.StatementPage })),
);

/** The receivables screens, inside the signed-in shell, behind their APIs' permissions. */
export function receivablesRoutes() {
  return (
    <>
      <Route path="receivables" element={guarded(RECEIVABLES_PERMISSION, ReceivablesPage)} />
      <Route path="parties/:id/statement" element={guarded(STATEMENT_PERMISSION, StatementPage)} />
    </>
  );
}
