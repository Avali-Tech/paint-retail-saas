import '../styles/customers.css';
import { lazy } from 'react';
import { Route } from 'react-router';
import { RequireAnyPermission } from '../lib/guard.js';
import { TIMELINE_PERMISSIONS } from './nav.js';

// Follow-ups and the activity timeline. Each screen is its own chunk, loaded when first opened.
const FollowUpsPage = lazy(() =>
  import('./FollowUpsPage.js').then((module) => ({ default: module.FollowUpsPage })),
);
const ActivitiesPage = lazy(() =>
  import('./ActivitiesPage.js').then((module) => ({ default: module.ActivitiesPage })),
);

/** Follow-ups (every signed-in member has their own) and record timelines. */
export function followUpRoutes() {
  return (
    <>
      <Route path="follow-ups" element={<FollowUpsPage />} />
      <Route
        path="activities"
        element={
          <RequireAnyPermission permissions={TIMELINE_PERMISSIONS}>
            <ActivitiesPage />
          </RequireAnyPermission>
        }
      />
    </>
  );
}
