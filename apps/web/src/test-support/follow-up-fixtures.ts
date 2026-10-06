import type { Activity, FollowUpPage } from '../api/follow-ups.js';
import { PARTY } from './party-fixtures.js';

export const ME = { memberId: 'member-1', name: 'Anil Kumar' };
export const RAVI = { memberId: 'member-2', name: 'Ravi Teja' };

/** An open follow-up due at 11:00 India time on 5 October 2026, overdue by now. */
export const FOLLOW_UP: Activity = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  record: { type: 'party', id: PARTY.id, label: 'Apex Builders' },
  type: 'call',
  subject: 'Call about the quote',
  notes: null,
  outcome: null,
  status: 'scheduled',
  dueAt: '2026-10-05T05:30:00.000Z',
  overdue: true,
  completedAt: null,
  cancelledAt: null,
  assignedTo: ME,
  createdBy: ME,
  createdAt: '2026-10-01T05:30:00.000Z',
};

export const LEAD_FOLLOW_UP: Activity = {
  ...FOLLOW_UP,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  record: { type: 'lead', id: 'lead-1', label: 'LD-000004 · Kondapur tower' },
  type: 'visit',
  subject: 'Site visit',
  dueAt: '2026-10-08T09:00:00.000Z',
  overdue: false,
  assignedTo: RAVI,
};

/** Done on 25 September, logged by Ravi for me. */
export const DONE_VISIT: Activity = {
  ...FOLLOW_UP,
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  type: 'visit',
  subject: 'Showed the shade card',
  notes: 'Liked Apex Ultima',
  outcome: 'Wants a quote',
  status: 'done',
  dueAt: null,
  overdue: false,
  completedAt: '2026-09-25T06:00:00.000Z',
  createdBy: RAVI,
};

export const CANCELLED_NOTE: Activity = {
  ...FOLLOW_UP,
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  type: 'note',
  subject: 'Old reminder',
  status: 'cancelled',
  dueAt: '2026-09-20T06:00:00.000Z',
  overdue: false,
  cancelledAt: '2026-09-21T06:00:00.000Z',
};

export const followUpPage = (
  items: Activity[],
  total = items.length,
  counts = { overdue: 1, today: 0 },
): FollowUpPage => ({ items, total, counts });
