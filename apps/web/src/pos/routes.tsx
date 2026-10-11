import './pos.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// The counter sale screen, its own chunk loaded when first opened.
const PosPage = lazy(() => import('./PosPage.js').then((module) => ({ default: module.PosPage })));

/** The counter sale screen (POS), inside the signed-in shell. */
export function posRoutes() {
  return <Route path="pos" element={guarded('billing:issue', PosPage)} />;
}
