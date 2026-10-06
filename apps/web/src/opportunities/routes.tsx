import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// Opportunity screens (styles come with the lead routes), each its own chunk.
const OpportunitiesPage = lazy(() =>
  import('./OpportunitiesPage.js').then((module) => ({ default: module.OpportunitiesPage })),
);
const OpportunityDetailPage = lazy(() =>
  import('./OpportunityDetailPage.js').then((module) => ({
    default: module.OpportunityDetailPage,
  })),
);

/** The opportunity screens, inside the signed-in shell. */
export function opportunityRoutes() {
  return (
    <>
      <Route path="opportunities" element={guarded('leads:read', OpportunitiesPage)} />
      <Route path="opportunities/:id" element={guarded('leads:read', OpportunityDetailPage)} />
    </>
  );
}
