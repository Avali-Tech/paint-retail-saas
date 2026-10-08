import '../styles/inventory.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Invoices (read-only), returns and notes, each its own chunk loaded when first opened.
const InvoicesPage = lazy(() =>
  import('./InvoicesPage.js').then((module) => ({ default: module.InvoicesPage })),
);
const InvoicePage = lazy(() =>
  import('./InvoicePage.js').then((module) => ({ default: module.InvoicePage })),
);
const NotesPage = lazy(() =>
  import('./NotesPage.js').then((module) => ({ default: module.NotesPage })),
);
const NotePage = lazy(() =>
  import('./NotePage.js').then((module) => ({ default: module.NotePage })),
);

/** The sales screens, inside the signed-in shell. */
export function salesRoutes() {
  return (
    <>
      <Route path="invoices" element={guarded('sales:read', InvoicesPage)} />
      <Route path="invoices/:id" element={guarded('sales:read', InvoicePage)} />
      <Route path="notes" element={guarded('sales:read', NotesPage)} />
      <Route path="notes/:id" element={guarded('sales:read', NotePage)} />
    </>
  );
}
