import type { ApiClient } from './client.js';

// Activities and follow-ups. Shapes mirror apps/api/src/activities
// (the API keeps them there, not yet in @paint/shared).

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

/** Records an activity can be about; customers, contractors, dealers and suppliers are parties. */
export const ACTIVITY_RECORD_TYPES = ['party', 'lead', 'opportunity', 'project'] as const;
export type ActivityRecordType = (typeof ACTIVITY_RECORD_TYPES)[number];

/** In India time: before today, today, after today, or every open one. */
export const FOLLOW_UP_WINDOWS = ['overdue', 'today', 'upcoming', 'open'] as const;
export type FollowUpWindow = (typeof FOLLOW_UP_WINDOWS)[number];

interface Person {
  readonly memberId: string;
  readonly name: string;
}

export interface Activity {
  readonly id: string;
  readonly record: {
    readonly type: ActivityRecordType;
    readonly id: string;
    /** e.g. "LD-000004 · Kondapur tower" or a party's name. */
    readonly label: string;
  };
  readonly type: ActivityType;
  readonly subject: string;
  readonly notes: string | null;
  readonly outcome: string | null;
  readonly status: 'scheduled' | 'done' | 'cancelled';
  readonly dueAt: string | null;
  /** Scheduled and past its time. */
  readonly overdue: boolean;
  readonly completedAt: string | null;
  readonly cancelledAt: string | null;
  readonly assignedTo: Person;
  readonly createdBy: Person;
  readonly createdAt: string;
}

export interface ActivityPage {
  readonly items: Activity[];
  readonly total: number;
}

export interface FollowUpPage extends ActivityPage {
  /** Open follow-ups due before today, and today (India time), for badges. */
  readonly counts: { readonly overdue: number; readonly today: number };
}

export interface FollowUpQuery {
  readonly when: FollowUpWindow;
  /** A member id, or "everyone" (members who can see the team); leave out for "me". */
  readonly assignedTo?: string;
  readonly storeId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * GET /activities: one record's timeline (recordType and recordId), or without
 * a record, activities on every record the member can see. Filters apply to both.
 */
export interface TimelineQuery {
  readonly recordType?: ActivityRecordType | undefined;
  readonly recordId?: string | undefined;
  readonly type?: ActivityType | undefined;
  /** Assigned to or logged by: a member id or "me". */
  readonly person?: string | undefined;
  /** India-time days, inclusive (YYYY-MM-DD). */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly limit?: number;
  readonly offset?: number;
}

/** PATCH /activities/:id: reschedule (a moment with its offset) or reassign. */
export interface ActivityChange {
  readonly subject?: string;
  readonly notes?: string | null;
  readonly dueAt?: string;
  readonly assignedMemberId?: string;
}

/** POST /activities/:id/complete: what came of it, and optionally the next step. */
export interface Completion {
  readonly outcome?: string;
  readonly next?: {
    readonly dueAt: string;
    readonly subject?: string;
    readonly type?: ActivityType;
  };
}

/** Where each kind of record opens in the web app (as the API's RECORD_PATHS). */
export const RECORD_PATHS: Readonly<Record<ActivityRecordType, string>> = {
  party: '/parties/',
  lead: '/leads/',
  opportunity: '/opportunities/',
  project: '/projects/',
};

export function followUpEndpoints(api: ApiClient) {
  return {
    followUps: (query: FollowUpQuery, signal?: AbortSignal) =>
      api.get<FollowUpPage>('/activities/follow-ups', { query: { ...query }, signal }),
    timeline: (query: TimelineQuery, signal?: AbortSignal) =>
      api.get<ActivityPage>('/activities', { query: { ...query }, signal }),
    update: (id: string, change: ActivityChange) =>
      api.patch<Activity>(`/activities/${id}`, change),
    complete: (id: string, completion: Completion) =>
      api.post<{ completed: Activity; next: Activity | null }>(
        `/activities/${id}/complete`,
        completion,
      ),
  };
}
