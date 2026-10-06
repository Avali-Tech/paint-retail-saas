import type { QueryClient } from '@tanstack/react-query';
import type { Activity, ActivityRecordType } from '../api/follow-ups.js';
import { RECORD_PATHS } from '../api/follow-ups.js';

/** Screens that show activities: follow-ups, timelines, the dashboard's counts and the customer 360. */
const ACTIVITY_QUERIES: ReadonlySet<unknown> = new Set([
  'follow-ups',
  'activities',
  'dashboard',
  'party',
]);

/** Reloads every screen that shows activities after one changed. */
export function refreshActivities(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: (query) => ACTIVITY_QUERIES.has(query.queryKey[0]),
  });
}

/** When it happened or is due: done, cancelled, else its due time (else when it was logged). */
export function activityMoment(activity: Activity): string {
  return activity.completedAt ?? activity.cancelledAt ?? activity.dueAt ?? activity.createdAt;
}

/** Where the record an activity is about opens. */
export function recordPath(record: { readonly type: ActivityRecordType; readonly id: string }) {
  return `${RECORD_PATHS[record.type]}${record.id}`;
}

/** The activity timeline of a record. */
export function timelinePath(record: { readonly type: ActivityRecordType; readonly id: string }) {
  return `/activities?${new URLSearchParams({ recordType: record.type, recordId: record.id }).toString()}`;
}
