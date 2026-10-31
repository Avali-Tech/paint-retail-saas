import { lazy } from 'react';
import { Route } from 'react-router';

// The inbox, its own chunk loaded when first opened.
const InboxPage = lazy(() =>
  import('./InboxPage.js').then((module) => ({ default: module.InboxPage })),
);

/** The "Needs action" inbox: every signed-in member has one. */
export function inboxRoutes() {
  return <Route path="inbox" element={<InboxPage />} />;
}
