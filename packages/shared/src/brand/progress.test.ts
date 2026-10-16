import { describe, expect, it } from 'vitest';
import { schemeProgress } from './progress.js';
import { grn, litresScheme } from './test-support/fixtures.js';

const L = 1000;

// The fixture scheme runs 2026-07-01 to 2026-09-30: 92 days.
const lines = [
  grn({
    id: 'a',
    receivedOn: '2026-07-10',
    valuePaise: 4_00_000_00,
    millilitres: 800 * L,
    freeMillilitres: 50 * L,
  }),
  grn({ id: 'b', receivedOn: '2026-08-01', valuePaise: 2_00_000_00, millilitres: 400 * L }),
  // A purchase return.
  grn({ id: 'c', receivedOn: '2026-08-05', valuePaise: -25_000_00, millilitres: -50 * L }),
  // After the as-of day, another brand, before the period.
  grn({ id: 'd', receivedOn: '2026-08-20', valuePaise: 9_00_000_00, millilitres: 9000 * L }),
  grn({ id: 'e', brandId: 'brand-b', valuePaise: 9_00_000_00, millilitres: 9000 * L }),
  grn({ id: 'f', receivedOn: '2026-06-30', valuePaise: 9_00_000_00, millilitres: 9000 * L }),
];

describe('schemeProgress', () => {
  it('measures, places and projects mid-period', () => {
    const progress = schemeProgress(litresScheme(), lines, '2026-08-15');
    expect(progress).toMatchObject({
      schemeId: 'scheme-1',
      asOf: '2026-08-15',
      // Free litres count toward litres, never toward value [CA-4].
      achievedValuePaise: 5_75_000_00,
      achievedMillilitres: 1200 * L,
      freeMillilitres: 50 * L,
      achieved: 1200 * L,
      current: { index: 0, slabId: 's1', target: 1000 * L },
      // 800 L to go over 46 days: 17,391.3 ml a day, rounded up.
      next: { index: 1, slabId: 's2', target: 2000 * L, distance: 800 * L, perDayNeeded: 17_392 },
      periodDays: 92,
      elapsedDays: 46,
      remainingDays: 46,
      // Half the period gone: double.
      projectedValuePaise: 11_50_000_00,
      projectedMillilitres: 2400 * L,
      projected: 2400 * L,
      projectedSlab: { index: 1, slabId: 's2', target: 2000 * L },
    });
    expect(progress.benefit.creditPaise).toBe(2_400_00);
    expect(progress.projectedBenefit.creditPaise).toBe(7_200_00);
  });

  it('measures a rupee scheme by value', () => {
    const scheme = litresScheme({
      measure: 'value',
      slabs: [
        { id: 'v1', target: 5_00_000_00, benefits: [{ kind: 'rebate', basisPoints: 100 }] },
        { id: 'v2', target: 10_00_000_00, benefits: [{ kind: 'rebate', basisPoints: 200 }] },
      ],
    });
    const progress = schemeProgress(scheme, lines, '2026-08-15');
    expect(progress.achieved).toBe(5_75_000_00);
    expect(progress.current?.slabId).toBe('v1');
    expect(progress.next).toMatchObject({ slabId: 'v2', distance: 4_25_000_00 });
    expect(progress.benefit.rebatePaise).toBe(5_750_00);
    expect(progress.projectedSlab?.slabId).toBe('v2');
    expect(progress.projectedBenefit.rebatePaise).toBe(23_000_00);
  });

  it('projects nothing before the period starts', () => {
    const progress = schemeProgress(litresScheme(), lines, '2026-06-30');
    expect(progress).toMatchObject({
      achieved: 0,
      current: null,
      next: { slabId: 's1', distance: 1000 * L, perDayNeeded: 10_870 },
      elapsedDays: 0,
      remainingDays: 92,
      projected: 0,
      projectedSlab: null,
    });
  });

  it('stops projecting once the period is over', () => {
    const progress = schemeProgress(litresScheme(), lines, '2026-10-20');
    // Line d now counts: 1,200 + 9,000 L.
    expect(progress).toMatchObject({
      achieved: 10_200 * L,
      current: { slabId: 's3' },
      next: null,
      elapsedDays: 92,
      remainingDays: 0,
      projected: 10_200 * L,
    });
    const short = schemeProgress(litresScheme(), lines.slice(0, 3), '2026-10-20');
    expect(short.next).toMatchObject({ slabId: 's2', perDayNeeded: null });
  });

  it('counts returns beyond purchases as nothing', () => {
    const progress = schemeProgress(
      litresScheme(),
      [grn({ valuePaise: -100, millilitres: -100 * L, freeMillilitres: 30 * L })],
      '2026-09-30',
    );
    expect(progress).toMatchObject({
      achievedValuePaise: 0,
      achievedMillilitres: 0,
      freeMillilitres: 0,
      achieved: 0,
    });
    const returnedFree = schemeProgress(
      litresScheme(),
      [grn({ millilitres: 10 * L, freeMillilitres: -5 * L })],
      '2026-09-30',
    );
    expect(returnedFree.freeMillilitres).toBe(0);
    expect(returnedFree.achievedMillilitres).toBe(5 * L);
  });

  it('refuses fractional lines and a broken scheme', () => {
    expect(() => schemeProgress(litresScheme(), [grn({ valuePaise: 1.5 })], '2026-09-30')).toThrow(
      'GRN line value',
    );
    expect(() => schemeProgress(litresScheme(), [grn({ millilitres: 0.5 })], '2026-09-30')).toThrow(
      'GRN line millilitres',
    );
    expect(() =>
      schemeProgress(litresScheme(), [grn({ freeMillilitres: 0.5 })], '2026-09-30'),
    ).toThrow('GRN line free millilitres');
    expect(() => schemeProgress(litresScheme({ slabs: [] }), [], '2026-09-30')).toThrow('no slabs');
  });
});
