import './schemes.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';
import { RequirePermission } from '../shell/guards.js';

// Brand schemes (P2-M33), each screen its own chunk loaded when first opened.
const SchemesPage = lazy(() =>
  import('./SchemesPage.js').then((module) => ({ default: module.SchemesPage })),
);
const NewSchemePage = lazy(() =>
  import('./SchemeEditorPage.js').then((module) => ({ default: module.NewSchemePage })),
);
const EditSchemePage = lazy(() =>
  import('./SchemeEditorPage.js').then((module) => ({ default: module.EditSchemePage })),
);
const SchemeDetailPage = lazy(() =>
  import('./SchemeDetailPage.js').then((module) => ({ default: module.SchemeDetailPage })),
);
const SchemeClaimsPage = lazy(() =>
  import('./SchemeClaimsPage.js').then((module) => ({ default: module.SchemeClaimsPage })),
);
const PriceHikePage = lazy(() =>
  import('./PriceHikePage.js').then((module) => ({ default: module.PriceHikePage })),
);

/** The brand scheme screens, inside the signed-in shell. */
export function schemeRoutes() {
  return (
    <>
      <Route path="brand-schemes" element={guarded('purchasing:read', SchemesPage)} />
      <Route path="brand-schemes/new" element={guarded('schemes:manage', NewSchemePage)} />
      <Route path="brand-schemes/claims" element={guarded('purchasing:read', SchemeClaimsPage)} />
      <Route
        path="brand-schemes/price-hike"
        element={
          <RequirePermission permission="costs:read">
            {guarded('purchasing:read', PriceHikePage)}
          </RequirePermission>
        }
      />
      <Route path="brand-schemes/:id" element={guarded('purchasing:read', SchemeDetailPage)} />
      <Route path="brand-schemes/:id/edit" element={guarded('schemes:manage', EditSchemePage)} />
    </>
  );
}
