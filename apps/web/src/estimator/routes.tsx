import './estimator.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// The paint estimator (spec §6.2), each screen its own chunk loaded when first opened.
const EstimatesPage = lazy(() =>
  import('./EstimatesPage.js').then((module) => ({ default: module.EstimatesPage })),
);
const EstimatePage = lazy(() =>
  import('./EstimatePage.js').then((module) => ({ default: module.EstimatePage })),
);

/**
 * The estimate screens, inside the signed-in shell. One route serves "new" and an
 * id, so a new estimate's editor survives its first save moving the address.
 */
export function estimatorRoutes() {
  return (
    <>
      <Route path="estimates" element={guarded('sales:read', EstimatesPage)} />
      <Route path="estimates/:id" element={guarded('sales:read', EstimatePage)} />
    </>
  );
}
