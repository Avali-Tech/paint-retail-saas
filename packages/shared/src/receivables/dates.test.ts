import { describe, expect, it } from 'vitest';
import { DAY_CACHE_LIMIT, addDays, dayNumber, daysBetween } from './dates.js';

describe('business-date arithmetic', () => {
  it('counts days between dates across months, years and leap days', () => {
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(daysBetween('2026-10-01', '2026-10-11')).toBe(10);
    expect(daysBetween('2026-10-11', '2026-10-01')).toBe(-10);
    expect(daysBetween('2027-12-31', '2028-03-01')).toBe(61);
    expect(daysBetween('2026-03-31', '2026-04-01')).toBe(1);
  });

  it('adds and subtracts days', () => {
    expect(addDays('2026-10-11', 6)).toBe('2026-10-17');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-10-11', 0)).toBe('2026-10-11');
  });

  it('refuses anything that is not a real calendar day', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '11-10-2026', '2026-10-1', '', 'today']) {
      expect(() => dayNumber(bad)).toThrow(RangeError);
    }
  });

  it('answers the same from its cache, and after the cache fills and starts again', () => {
    expect(dayNumber('2026-10-11')).toBe(dayNumber('2026-10-11'));
    // More distinct dates than the cache keeps: each is still worked out right.
    for (let day = 0; day <= DAY_CACHE_LIMIT; day += 1) {
      expect(dayNumber(addDays('2000-01-01', day))).toBe(10_957 + day);
    }
    expect(dayNumber('2026-10-11')).toBe(20_737);
    expect(() => dayNumber('2026-02-30')).toThrow(RangeError);
  });
});
