import { describe, expect, it } from 'vitest';
import {
  formatCompactMoney,
  formatDate,
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelativeTime,
} from './format.js';

describe('Indian number formats', () => {
  it('groups in lakhs and crores', () => {
    expect(formatNumber(1234567)).toBe('12,34,567');
    expect(formatNumber(12.345)).toBe('12.35');
    expect(formatNumber(1234567, 'en-US')).toBe('1,234,567');
  });

  it('shows paise as rupees', () => {
    expect(formatMoney(85_000_050)).toBe('₹8,50,000.50');
  });

  it('shortens large amounts to lakhs and crores', () => {
    expect(formatCompactMoney(99_900)).toBe('₹999');
    expect(formatCompactMoney(850_000)).toBe('₹8,500');
    expect(formatCompactMoney(850_000_00)).toBe('₹8.5 L');
    expect(formatCompactMoney(12_500_000_00)).toBe('₹1.25 Cr');
    expect(formatCompactMoney(1_234_567_890_00)).toBe('₹123.46 Cr');
    expect(formatCompactMoney(-150_000_00)).toBe('-₹1.5 L');
    expect(formatCompactMoney(-5_000)).toBe('-₹50');
  });
});

describe('dates in India time', () => {
  // 19:00 UTC is 00:30 the next day in India.
  const iso = '2026-09-30T19:00:00.000Z';

  it('formats dates and times in Asia/Kolkata', () => {
    expect(formatDate(iso)).toBe('1 Oct 2026');
    expect(formatDateTime(iso)).toBe('1 Oct 2026, 12:30 am');
  });

  it('says how long ago, and falls back to the date after a week', () => {
    const now = Date.parse('2026-10-01T12:00:00.000Z');
    expect(formatRelativeTime('2026-10-01T11:59:30.000Z', now)).toBe('now');
    expect(formatRelativeTime('2026-10-01T11:55:00.000Z', now)).toBe('5 minutes ago');
    expect(formatRelativeTime('2026-10-01T09:00:00.000Z', now)).toBe('3 hours ago');
    expect(formatRelativeTime('2026-09-30T12:00:00.000Z', now)).toBe('yesterday');
    expect(formatRelativeTime('2026-10-01T14:00:00.000Z', now)).toBe('in 2 hours');
    expect(formatRelativeTime('2026-09-20T12:00:00.000Z', now)).toBe('20 Sept 2026');
    expect(formatRelativeTime(new Date().toISOString())).toBe('now');
  });
});
