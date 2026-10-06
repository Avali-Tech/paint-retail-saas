import { describe, expect, it } from 'vitest';
import {
  CANCELLED_NOTE,
  DONE_VISIT,
  FOLLOW_UP,
  LEAD_FOLLOW_UP,
} from '../test-support/follow-up-fixtures.js';
import { activityMoment, recordPath, timelinePath } from './activity-helpers.js';

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
});
