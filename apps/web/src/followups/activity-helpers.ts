import type { QueryClient } from '@tanstack/react-query';
import type { Activity, ActivityRecordType } from '../api/follow-ups.js';
import { RECORD_PATHS } from '../api/follow-ups.js';
import { indiaDay } from '../lib/india-time.js';

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

export interface TimelineFilters {
  readonly type: string;
  /** A member id: who logged it or is assigned it. */
  readonly person: string;
  /** India calendar days, inclusive; "" for open-ended. */
  readonly from: string;
  readonly to: string;
}

/** The activities matching the timeline's filters (empty filters match everything). */
export function filterActivities(
  activities: readonly Activity[],
  filters: TimelineFilters,
): Activity[] {
  return activities.filter((activity) => {
    const day = indiaDay(activityMoment(activity));
    return (
      (filters.type === '' || activity.type === filters.type) &&
      (filters.person === '' ||
        activity.createdBy.memberId === filters.person ||
        activity.assignedTo.memberId === filters.person) &&
      (filters.from === '' || day >= filters.from) &&
      (filters.to === '' || day <= filters.to)
    );
  });
}

/** Everyone who logged or is assigned one of the activities, by name. */
export function peopleIn(activities: readonly Activity[]): { id: string; name: string }[] {
  const people = new Map<string, string>();
  for (const activity of activities) {
    people.set(activity.createdBy.memberId, activity.createdBy.name);
    people.set(activity.assignedTo.memberId, activity.assignedTo.name);
  }
  return [...people]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
