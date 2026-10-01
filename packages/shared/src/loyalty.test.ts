import { describe, expect, it } from 'vitest';
import { pointLots, pointsForPurchase, tierFor } from './index.js';

const perHundredRupees = { earnPoints: 1, earnPerPaise: 10_000 };

describe('pointsForPurchase', () => {
  it('earns 500 points on ₹50,000 at 1 point per ₹100, as in the spec', () => {
    expect(pointsForPurchase(50_000_00, perHundredRupees)).toBe(500);
  });

  it('rounds down, and earns nothing on nothing', () => {
    expect(pointsForPurchase(99_99, perHundredRupees)).toBe(0);
    expect(pointsForPurchase(199_99, perHundredRupees)).toBe(1);
    expect(pointsForPurchase(0, perHundredRupees)).toBe(0);
    expect(pointsForPurchase(-100_00, perHundredRupees)).toBe(0);
  });

  it('stays exact for large amounts and odd rates', () => {
    expect(pointsForPurchase(9_000_000_000_000_00, { earnPoints: 7, earnPerPaise: 3 })).toBe(
      2_100_000_000_000_000,
    );
    expect(pointsForPurchase(1_000, { earnPoints: 3, earnPerPaise: 7 })).toBe(428);
  });

  it('refuses amounts that are not whole paise', () => {
    expect(() => pointsForPurchase(1.5, perHundredRupees)).toThrow(RangeError);
  });
});

describe('tierFor', () => {
  const tiers = [
    { name: 'Gold', minPoints: 5_000 },
    { name: 'Silver', minPoints: 1_000 },
    { name: 'Platinum', minPoints: 20_000 },
  ];

  it('finds the highest tier reached and how far the next one is', () => {
    expect(tierFor(0, tiers)).toEqual({
      current: null,
      next: { name: 'Silver', minPoints: 1_000, pointsToGo: 1_000 },
    });
    expect(tierFor(1_000, tiers)).toEqual({
      current: { name: 'Silver', minPoints: 1_000 },
      next: { name: 'Gold', minPoints: 5_000, pointsToGo: 4_000 },
    });
    expect(tierFor(25_000, tiers)).toEqual({
      current: { name: 'Platinum', minPoints: 20_000 },
      next: null,
    });
  });

  it('has no tiers when the programme has none', () => {
    expect(tierFor(100, [])).toEqual({ current: null, next: null });
  });
});

describe('pointLots', () => {
  const today = '2026-10-01';

  it('expires unused points of lots past their day, not on it', () => {
    expect(
      pointLots(
        [
          { points: 100, expiresOn: '2026-09-30' },
          { points: 50, expiresOn: '2026-10-01' },
        ],
        today,
      ),
    ).toEqual({ expired: 100, nextExpiry: { points: 50, expiresOn: '2026-10-01' } });
  });

  it('uses the soonest-expiring points first, whatever order they were earned in', () => {
    const entries = [
      { points: 100, expiresOn: '2027-03-01' },
      { points: 100, expiresOn: '2026-09-01' },
      { points: -150, expiresOn: null },
    ];

    expect(pointLots(entries, today)).toEqual({
      expired: 0,
      nextExpiry: { points: 50, expiresOn: '2027-03-01' },
    });
  });

  it('does not expire points already used or already written off', () => {
    const entries = [
      { points: 100, expiresOn: '2026-08-01' },
      { points: 200, expiresOn: '2026-09-01' },
      { points: -30, expiresOn: null },
      // An earlier run wrote off the first lot's remaining 70.
      { points: -70, expiresOn: null },
    ];

    expect(pointLots(entries, today).expired).toBe(200);
    expect(pointLots([...entries, { points: -200, expiresOn: null }], today)).toEqual({
      expired: 0,
      nextExpiry: null,
    });
  });

  it('never expires points without an expiry date, and uses them last', () => {
    const entries = [
      { points: 100, expiresOn: null },
      { points: 100, expiresOn: '2026-09-15' },
      { points: -120, expiresOn: null },
    ];

    expect(pointLots(entries, today)).toEqual({ expired: 0, nextExpiry: null });
    expect(pointLots([{ points: 100, expiresOn: null }], today).expired).toBe(0);
  });

  it('adds up lots expiring on the same day', () => {
    expect(
      pointLots(
        [
          { points: 10, expiresOn: '2026-12-31' },
          { points: 20, expiresOn: '2026-12-31' },
          { points: 30, expiresOn: '2027-06-30' },
        ],
        today,
      ).nextExpiry,
    ).toEqual({ points: 30, expiresOn: '2026-12-31' });
  });
});
