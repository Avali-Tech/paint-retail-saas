import type { ApiClient } from './client.js';
import type { Person } from './leads.js';
import type { Page } from './page.js';

// The activities on one lead, opportunity or project: its timeline, and logging
// or scheduling a call, visit or note. Shapes mirror apps/api/src/activities.

export const ACTIVITY_TYPES = [
  'call',
  'meeting',
  'visit',
  'whatsapp',
  'email',
  'follow_up',
  'note',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export type CrmRecordType = 'lead' | 'opportunity' | 'project';

export interface Activity {
  readonly id: string;
  readonly record: { readonly type: string; readonly id: string; readonly label: string };
  readonly type: ActivityType;
  readonly subject: string;
  readonly notes: string | null;
  readonly outcome: string | null;
  readonly status: 'scheduled' | 'done' | 'cancelled';
  readonly dueAt: string | null;
  readonly overdue: boolean;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly assignedTo: Person;
  readonly createdBy: Person;
  readonly createdAt: string;
}

/** POST /activities: without dueAt it is logged as done now; with dueAt it is scheduled. */
export interface ActivityInput {
  readonly recordType: CrmRecordType;
  readonly recordId: string;
  readonly type: ActivityType;
  readonly subject: string;
  readonly notes?: string;
  readonly outcome?: string;
  /** With its offset, e.g. 2026-10-02T11:00:00+05:30. */
  readonly dueAt?: string;
}

export function recordActivityEndpoints(api: ApiClient) {
  return {
    timeline: (recordType: CrmRecordType, recordId: string, signal?: AbortSignal) =>
      api.get<Page<Activity>>('/activities', { query: { recordType, recordId }, signal }),
    add: (input: ActivityInput) => api.post<Activity>('/activities', input),
  };
}
