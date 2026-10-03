import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';
import '../styles/customers.css';

// Customers, credit and loyalty. Each screen is its own chunk, loaded when first opened.
const PartiesPage = lazy(() =>
  import('./PartiesPage.js').then((module) => ({ default: module.PartiesPage })),
);
const PartyDetailPage = lazy(() =>
  import('./PartyDetailPage.js').then((module) => ({ default: module.PartyDetailPage })),
);
const NewPartyPage = lazy(() =>
  import('./PartyFormPage.js').then((module) => ({ default: module.NewPartyPage })),
);
const EditPartyPage = lazy(() =>
  import('./PartyFormPage.js').then((module) => ({ default: module.EditPartyPage })),
);
const CreditRequestsPage = lazy(() =>
  import('../credit/CreditRequestsPage.js').then((module) => ({
    default: module.CreditRequestsPage,
  })),
);
const CreditRequestPage = lazy(() =>
  import('../credit/CreditRequestPage.js').then((module) => ({
    default: module.CreditRequestPage,
  })),
);
const CreditRulesPage = lazy(() =>
  import('../credit/CreditRulesPage.js').then((module) => ({ default: module.CreditRulesPage })),
);
const LoyaltySettingsPage = lazy(() =>
  import('../loyalty/LoyaltySettingsPage.js').then((module) => ({
    default: module.LoyaltySettingsPage,
  })),
);

/** The customer, credit and loyalty screens, inside the signed-in shell. */
export function partyRoutes() {
  return (
    <>
      <Route path="parties" element={guarded('parties:read', PartiesPage)} />
      <Route path="parties/new" element={guarded('parties:manage', NewPartyPage)} />
      <Route path="parties/:id" element={guarded('parties:read', PartyDetailPage)} />
      <Route path="parties/:id/edit" element={guarded('parties:manage', EditPartyPage)} />
      <Route path="credit-requests" element={guarded('credit:read', CreditRequestsPage)} />
      <Route path="credit-requests/:id" element={guarded('credit:read', CreditRequestPage)} />
      <Route path="settings/credit" element={guarded('credit:read', CreditRulesPage)} />
      <Route path="settings/loyalty" element={guarded('loyalty:read', LoyaltySettingsPage)} />
    </>
  );
}
