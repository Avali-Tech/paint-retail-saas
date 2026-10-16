import './statements.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Brand statement reconciliation (P2-M34), each screen its own chunk loaded when first opened.
const StatementsPage = lazy(() =>
  import('./StatementsPage.js').then((module) => ({ default: module.StatementsPage })),
);
const TemplatesPage = lazy(() =>
  import('./TemplatesPage.js').then((module) => ({ default: module.TemplatesPage })),
);
const NewTemplatePage = lazy(() =>
  import('./TemplateEditorPage.js').then((module) => ({ default: module.NewTemplatePage })),
);
const EditTemplatePage = lazy(() =>
  import('./TemplateEditorPage.js').then((module) => ({ default: module.EditTemplatePage })),
);
const UploadPage = lazy(() =>
  import('./UploadPage.js').then((module) => ({ default: module.UploadPage })),
);
const ReconcilePage = lazy(() =>
  import('./ReconcilePage.js').then((module) => ({ default: module.ReconcilePage })),
);

/** The brand statement screens, inside the signed-in shell. */
export function statementRoutes() {
  return (
    <>
      <Route path="brand-statements" element={guarded('purchasing:read', StatementsPage)} />
      <Route
        path="brand-statements/templates"
        element={guarded('purchasing:read', TemplatesPage)}
      />
      <Route
        path="brand-statements/templates/new"
        element={guarded('schemes:manage', NewTemplatePage)}
      />
      <Route
        path="brand-statements/templates/:id/edit"
        element={guarded('schemes:manage', EditTemplatePage)}
      />
      <Route path="brand-statements/upload" element={guarded('schemes:manage', UploadPage)} />
      <Route path="brand-statements/:id" element={guarded('purchasing:read', ReconcilePage)} />
    </>
  );
}
