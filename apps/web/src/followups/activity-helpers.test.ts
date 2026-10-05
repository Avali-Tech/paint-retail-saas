import { describe, expect, it } from 'vitest';
import {
  CANCELLED_NOTE,
  DONE_VISIT,
  FOLLOW_UP,
  LEAD_FOLLOW_UP,
  ME,
  RAVI,
} from '../test-support/follow-up-fixtures.js';
import {
  activityMoment,
  filterActivities,
  peopleIn,
  recordPath,
  timelinePath,
} from './activity-helpers.js';

const ALL = { type: '', person: '', from: '', to: '' };

describe('activity helpers', () => {
  it('knows when each activity happened or is due', () => {
    expect(activityMoment(DONE_VISIT)).toBe(DONE_VISIT.completedAt);
    expect(activityMoment(CANCELLED_NOTE)).toBe(CANCELLED_NOTE.cancelledAt);
    expect(activityMoment(FOLLOW_UP)).toBe(FOLLOW_UP.dueAt);
    expect(activityMoment({ ...FOLLOW_UP, dueAt: null })).toBe(FOLLOW_UP.createdAt);
  });

  it('links to the record and its timeline', () => {
    expect(recordPath(LEAD_FOLLOW_UP.record)).toBe('/leads/lead-1');
    expect(timelinePath(FOLLOW_UP.record)).toBe(
      `/activities?recordType=party&recordId=${FOLLOW_UP.record.id}`,
    );
  });

  it('filters by type, person and India-time days', () => {
    const list = [FOLLOW_UP, DONE_VISIT, CANCELLED_NOTE, LEAD_FOLLOW_UP];
    expect(filterActivities(list, ALL)).toEqual(list);
    expect(filterActivities(list, { ...ALL, type: 'visit' })).toEqual([DONE_VISIT, LEAD_FOLLOW_UP]);
    // Ravi logged the visit and is assigned the lead's follow-up.
    expect(filterActivities(list, { ...ALL, person: RAVI.memberId })).toEqual([
      DONE_VISIT,
      LEAD_FOLLOW_UP,
    ]);
    expect(filterActivities(list, { ...ALL, from: '2026-10-01' })).toEqual([
      FOLLOW_UP,
      LEAD_FOLLOW_UP,
    ]);
    expect(filterActivities(list, { ...ALL, from: '2026-09-21', to: '2026-09-30' })).toEqual([
      DONE_VISIT,
      CANCELLED_NOTE,
    ]);
  });

  it('lists everyone involved once, by name', () => {
    expect(peopleIn([FOLLOW_UP, DONE_VISIT, LEAD_FOLLOW_UP])).toEqual([
      { id: ME.memberId, name: ME.name },
      { id: RAVI.memberId, name: RAVI.name },
    ]);
  });
});
