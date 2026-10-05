import '../styles/customers.css';
import '../styles/inventory.css';
import './crm.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Lead screens, each its own chunk loaded when first opened.
const LeadsPage = lazy(() =>
  import('./LeadsPage.js').then((module) => ({ default: module.LeadsPage })),
);
const LeadBoardPage = lazy(() =>
  import('./LeadBoardPage.js').then((module) => ({ default: module.LeadBoardPage })),
);
const NewLeadPage = lazy(() =>
  import('./LeadFormPage.js').then((module) => ({ default: module.NewLeadPage })),
);
const EditLeadPage = lazy(() =>
  import('./LeadFormPage.js').then((module) => ({ default: module.EditLeadPage })),
);
const LeadDetailPage = lazy(() =>
  import('./LeadDetailPage.js').then((module) => ({ default: module.LeadDetailPage })),
);

/** The lead screens, inside the signed-in shell. */
export function leadRoutes() {
  return (
    <>
      <Route path="leads" element={guarded('leads:read', LeadsPage)} />
      <Route path="leads/board" element={guarded('leads:read', LeadBoardPage)} />
      <Route path="leads/new" element={guarded('leads:manage', NewLeadPage)} />
      <Route path="leads/:id" element={guarded('leads:read', LeadDetailPage)} />
      <Route path="leads/:id/edit" element={guarded('leads:manage', EditLeadPage)} />
    </>
  );
}
