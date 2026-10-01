import { describe, expect, it } from 'vitest';
import { addDays, defaultRenewalDate, todayInIndia } from './contract-dates.js';

describe('addDays', () => {
  it('moves across months, years and leap days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2026-10-01', 0)).toBe('2026-10-01');
  });
});

describe('defaultRenewalDate', () => {
  it('is 30 days before the end', () => {
    expect(defaultRenewalDate('2026-04-01', '2027-03-31')).toBe('2027-03-01');
  });

  it('is the start date for contracts shorter than the notice period', () => {
    expect(defaultRenewalDate('2026-10-01', '2026-10-20')).toBe('2026-10-01');
    expect(defaultRenewalDate('2026-10-01', '2026-10-31')).toBe('2026-10-01');
  });
});

describe('todayInIndia', () => {
  it('turns over at midnight in India, not UTC', () => {
    expect(todayInIndia(new Date('2026-09-30T18:29:59Z'))).toBe('2026-09-30');
    expect(todayInIndia(new Date('2026-09-30T18:30:00Z'))).toBe('2026-10-01');
    expect(todayInIndia()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
