import { lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// The business's subscription. Each screen is its own chunk.
const BillingPage = lazy(() =>
  import('./BillingPage.js').then((module) => ({ default: module.BillingPage })),
);
const FakeCheckoutPage = lazy(() =>
  import('./FakeCheckoutPage.js').then((module) => ({ default: module.FakeCheckoutPage })),
);

/** Billing and the fake gateway's checkout: organization:manage, then the owner only. */
export function billingRoutes() {
  return (
    <>
      <Route path="settings/billing" element={guarded('organization:manage', BillingPage)} />
      <Route
        path="billing/checkout/:id"
        element={guarded('organization:manage', FakeCheckoutPage)}
      />
    </>
  );
}
