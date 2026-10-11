import { lazy } from 'react';
import { Route } from 'react-router';

// The invoice print preview, its own chunk. Sample data only, so any signed-in member may open it.
const PrintPreviewPage = lazy(() =>
  import('./PrintPreviewPage.js').then((module) => ({ default: module.PrintPreviewPage })),
);

export function printRoutes() {
  return <Route path="print-preview" element={<PrintPreviewPage />} />;
}
