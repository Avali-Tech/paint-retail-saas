import { PAYMENT_LINK_READ_PERMISSION } from '@paint/shared';
import { Suspense, lazy } from 'react';
import { Route } from 'react-router';
import { guarded } from '../app/guarded.js';

// UPI payment links, each screen its own chunk loaded when first opened.
const PaymentLinksPage = lazy(() =>
  import('./PaymentLinksPage.js').then((module) => ({ default: module.PaymentLinksPage })),
);
const LogCheckoutPage = lazy(() =>
  import('./LogCheckoutPage.js').then((module) => ({ default: module.LogCheckoutPage })),
);

/** The payment links list, inside the signed-in shell. */
export function paymentLinkRoutes() {
  return (
    <Route path="payment-links" element={guarded(PAYMENT_LINK_READ_PERMISSION, PaymentLinksPage)} />
  );
}

/** The log provider's test payment page: the customer's side, outside the signed-in shell. */
export function publicPaymentLinkRoutes() {
  return (
    <Route
      path="/pay/:reference"
      element={
        <Suspense fallback={null}>
          <LogCheckoutPage />
        </Suspense>
      }
    />
  );
}
