import { describe, expect, it } from 'vitest';
import {
  COLLECTIONS_MANAGE_PERMISSION,
  DEFAULT_REMINDER_OFFSETS,
  REMINDER_OFFSET_MAX,
  REMINDER_OFFSET_MIN,
  REMINDER_SETTINGS_PERMISSION,
  compareWorklist,
  isMessagingHour,
  isPermission,
  nextStep,
  promiseKept,
  reminderTemplate,
  type NextStep,
} from '../index.js';

describe('collections rules', () => {
  it('use known permissions and sensible default offsets', () => {
    expect(isPermission(COLLECTIONS_MANAGE_PERMISSION)).toBe(true);
    expect(isPermission(REMINDER_SETTINGS_PERMISSION)).toBe(true);
    for (const offset of DEFAULT_REMINDER_OFFSETS) {
      expect(offset).toBeGreaterThanOrEqual(REMINDER_OFFSET_MIN);
      expect(offset).toBeLessThanOrEqual(REMINDER_OFFSET_MAX);
    }
  });

  it.each([
    ['2026-10-16T03:29:00Z', false], // 08:59 IST
    ['2026-10-16T03:30:00Z', true], // 09:00 IST
    ['2026-10-16T14:29:00Z', true], // 19:59 IST
    ['2026-10-16T14:30:00Z', false], // 20:00 IST
    ['2026-10-16T20:00:00Z', false], // 01:30 IST next day
  ])('messages parties only between 09:00 and 20:00 IST: %s', (instant, open) => {
    expect(isMessagingHour(new Date(instant))).toBe(open);
  });

  it('reminds before and on the due date, then of what is overdue', () => {
    expect(reminderTemplate(-3)).toBe('payment_reminder_due');
    expect(reminderTemplate(0)).toBe('payment_reminder_due');
    expect(reminderTemplate(1)).toBe('payment_reminder_overdue');
  });

  it('keeps a promise when the payments cover it, to the paisa', () => {
    expect(promiseKept(50_000, 50_000)).toBe(true);
    expect(promiseKept(50_000, 49_999)).toBe(false);
  });

  it('picks the next step', () => {
    expect(nextStep('2026-10-16', true, { promisedOn: '2026-10-20' })).toBe(
      'acknowledge_escalation',
    );
    expect(nextStep('2026-10-16', false, null)).toBe('contact');
    expect(nextStep('2026-10-16', false, { promisedOn: '2026-10-16' })).toBe('follow_up_promise');
    expect(nextStep('2026-10-16', false, { promisedOn: '2026-10-17' })).toBe('await_promise');
  });

  it('orders the worklist by step, then age, then amount, then name', () => {
    const row = (name: string, step: NextStep, days: number, overdue: number) => ({
      name,
      nextStep: step,
      maxDaysPastDue: days,
      overduePaise: overdue,
    });
    const rows = [
      row('Waiting', 'await_promise', 100, 9),
      row('Young', 'contact', 5, 9),
      row('Bigger', 'contact', 40, 900),
      row('Ankit', 'contact', 40, 100),
      row('Bala', 'contact', 40, 100),
      row('Promise', 'follow_up_promise', 1, 1),
      row('Escalated', 'acknowledge_escalation', 1, 1),
    ];
    expect([...rows].sort(compareWorklist).map((r) => r.name)).toEqual([
      'Escalated',
      'Promise',
      'Bigger',
      'Ankit',
      'Bala',
      'Young',
      'Waiting',
    ]);
  });
});
