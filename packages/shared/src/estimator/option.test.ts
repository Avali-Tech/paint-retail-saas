import { describe, expect, it } from 'vitest';
import { estimateTier, estimateTiers, isTierProblem, type TierChoice } from './option.js';
import type { EstimatorSurface } from './quantities.js';

const WALL: EstimatorSurface = {
  netAreaSqft: 1350,
  coats: 2,
  condition: 'new',
  primer: true,
  putty: true,
};
const OLD_WALL: EstimatorSurface = { ...WALL, condition: 'repaint', primer: false, putty: false };

const PAINT_PACKS = [
  { variantId: 'p1', size: 1_000, pricePaise: 250_00 },
  { variantId: 'p4', size: 4_000, pricePaise: 900_00 },
  { variantId: 'p20', size: 20_000, pricePaise: 4_000_00 },
];
const GOOD: TierChoice = {
  tier: 'good',
  paint: { coverageSqftPerLitre: 120, defaultCoats: 2, packs: PAINT_PACKS },
  primer: {
    coverageSqftPerLitre: 135,
    defaultCoats: 1,
    packs: [{ variantId: 'pr10', size: 10_000, pricePaise: 1_500_00 }],
  },
  putty: {
    packs: [
      { variantId: 'pt20', size: 20_000, pricePaise: 1_100_00 },
      { variantId: 'pt5', size: 5_000, pricePaise: 330_00 },
    ],
  },
};

describe('estimateTier', () => {
  it('prices paint, primer and putty as the cheapest mixes', () => {
    const outcome = estimateTier([WALL], GOOD);
    expect(outcome).toEqual({
      tier: 'good',
      paintMl: 23_625,
      primerMl: 10_500,
      puttyGrams: 99_225,
      lines: [
        {
          purpose: 'paint',
          variantId: 'p20',
          quantity: 1,
          unitPricePaise: 4_000_00,
          totalPaise: 4_000_00,
        },
        {
          purpose: 'paint',
          variantId: 'p4',
          quantity: 1,
          unitPricePaise: 900_00,
          totalPaise: 900_00,
        },
        {
          purpose: 'primer',
          variantId: 'pr10',
          quantity: 2,
          unitPricePaise: 1_500_00,
          totalPaise: 3_000_00,
        },
        {
          purpose: 'putty',
          variantId: 'pt20',
          quantity: 5,
          unitPricePaise: 1_100_00,
          totalPaise: 5_500_00,
        },
      ],
      totalPaise: 13_400_00,
    });
    expect(isTierProblem(outcome)).toBe(false);
  });

  it('skips primer and putty when no surface takes them, or no product is chosen', () => {
    expect(estimateTier([OLD_WALL], GOOD)).toMatchObject({
      primerMl: 0,
      puttyGrams: 0,
      totalPaise: 4_900_00,
    });
    expect(
      estimateTier([WALL], { tier: 'good', paint: GOOD.paint, primer: null, putty: null }),
    ).toMatchObject({
      primerMl: 0,
      puttyGrams: 0,
      totalPaise: 4_900_00,
    });
  });

  it('says which product cannot be priced', () => {
    const noPacks = { coverageSqftPerLitre: 120, defaultCoats: null, packs: [] };
    const noCoverage = { ...noPacks, coverageSqftPerLitre: null };
    expect(estimateTier([WALL], { ...GOOD, paint: noCoverage })).toEqual({
      tier: 'good',
      problem: 'noCoverage',
      purpose: 'paint',
    });
    expect(estimateTier([WALL], { ...GOOD, paint: noPacks })).toMatchObject({
      problem: 'noPacks',
      purpose: 'paint',
    });
    expect(estimateTier([WALL], { ...GOOD, primer: noCoverage })).toMatchObject({
      problem: 'noCoverage',
      purpose: 'primer',
    });
    expect(estimateTier([WALL], { ...GOOD, primer: noPacks })).toMatchObject({
      problem: 'noPacks',
      purpose: 'primer',
    });
    const outcome = estimateTier([WALL], { ...GOOD, putty: { packs: [] } });
    expect(outcome).toMatchObject({ problem: 'noPacks', purpose: 'putty' });
    expect(isTierProblem(outcome)).toBe(true);
  });
});

describe('estimateTiers', () => {
  it('runs every tier through the same function, in good / better / best order', () => {
    const best: TierChoice = {
      tier: 'best',
      paint: {
        coverageSqftPerLitre: 140,
        defaultCoats: 2,
        packs: [{ variantId: 'b20', size: 20_000, pricePaise: 9_000_00 }],
      },
    };
    const better: TierChoice = {
      ...GOOD,
      tier: 'better',
      paint: { ...GOOD.paint, coverageSqftPerLitre: 130 },
    };
    const outcomes = estimateTiers([OLD_WALL], [best, GOOD, better], 0);
    expect(outcomes.map((outcome) => outcome.tier)).toEqual(['good', 'better', 'best']);
    expect(outcomes.map((outcome) => ('paintMl' in outcome ? outcome.paintMl : null))).toEqual([
      22_500, 20_770, 19_286,
    ]);
    expect(estimateTiers([OLD_WALL], [GOOD])[0]).toMatchObject({ paintMl: 23_625 });
  });
});
